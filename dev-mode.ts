#!/usr/bin/env node
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import repl from 'repl'
import { spawn, IPty } from 'node-pty'
import minimist from 'minimist'
import { split, quote } from 'shell-split'

const defaultConfigFilename = '.dev-mode.json'
const defaultSecretdir = '.dev-secrets'
const defaultLogdir = 'logs'

const help: { [topic: string]: string } = {}
help.help = `
dev-mode is a REPL for running subprocesses. Think of it like an interactive
Procfile, or docker-compose without docker. It's meant to run continuously in a
terminal and allow you to quickly start & stop processes in a reproducible way.

status                  Show the status of all jobs.
start [JOB_NAME]        Start job(s).
stop [JOB_NAME]         Stop job(s).
connect JOB_NAME        Connect a specific job to your terminal.

add JOB_NAME COMMAND    Add a job to your configuration.
rm JOB_NAME             Remove a job from your configuration.

show CONFIG_PATH        Show a config value
set CONFIG_PATH VALUE   Set a config value

help [COMMAND]          Show this help, or detailed help for a command.
help config             Show documentation for configuration values.
`

help.status = `
status

Show the status of all jobs.
`

help.start = `
start [JOB_NAME]

Starts a job, or all jobs if no JOB_NAME is specified.
`

help.stop = `
stop [JOB_NAME]

Stops a job, or all jobs if no JOB_NAME is specified.
`

help.connect = `
connect JOB_NAME

Connect your terminal to the given job, starting it if necessary. Your terminal
will be returned to dev-mode if the job exits. You can disconnect from a running
job by pressing 'Ctrl-a d'
`

help.add = `
add [OPTIONS] JOB_NAME COMMAND

Adds a job to your config file. Everything following the job name will be
treated as the command to run. The job will be started immediately and the
config value for jobs.$JOB_NAME.autostart will be set to true.

Options:

    --(no-)autostart   Whether this jobs starts with dev-mode. (default true)
    --(no-)restart     Whether to restart this job after exits. (default true)
    --env, -e          Define key=val env vars for the job. Can be repeated.

Examples:

    add --env RAILS_ENV=development rails bundle exec rails server
    add redis docker kill my-redis; docker run --rm --name my-redis -i redis

See also:

  'help set' for modifying configuration of existing jobs.
  'help config' for details on config values.
`

help.rm = `
rm JOB_NAME

Removes a job from your config. Warning: there is no undo! Usually you want the
'stop JOB_NAME' command instead of this one.
`

help.show = `
show CONFIG_PATH

Prints values from the config file. Job configurations are stored under the
"jobs" key.

Examples:

    show jobs.rails.cmd
    show jobs.rails.env
    show jobs.rails.env.RAILS_ENV
    show jobs.rails.autostart

See also: 'help config'
`

help.set = `
set CONFIG_PATH VALUE

Sets configuration values. Everything following the path will be parsed as JSON.
Configuration changes are immediately applied and persisted, see "help config"
for more details.

Examples:

    set jobs.rails.autostart false
    set jobs.rails.env.RAILS_ENV production
`
help.config = `
dev-mode uses a JSON config file conventionally named ".dev-mode.json"

It's recommended that you this config file into source control to keep track of
changes and share the configuration between contributors to a project.

Changes to the configuration made with the 'set' command are immediately saved
to disk, and you can also edit the config file directly. dev-mode watches it
for changes and reloads automatically.

Global config values:

  logdir     The directory where log files are created. The default is "./log".

Per job config values:

  jobs.$job_name.cmd              The command to run for this job.
  jobs.$job_name.env.$var_name    Environment variables for the command.
  jobs.$job_name.autostart        Does this job start with dev-mode?
  jobs.$job_name.restart          Restart this job after it exits?
`

interface Config {
  logdir: string
  secretdir: string
  jobs: {
    [jobName: string]: JobConfig
  }
}

interface JobConfig {
  cmd: string
  env: { [variable: string]: string }
  autostart: boolean
  restart: boolean
  autoconnect?: RegExp
}

function loadConfig(filename: string): Config {
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf-8'))
  if (!parsed.jobs) {
    parsed.jobs = {}
  }
  if (!parsed.logdir) {
    parsed.logdir = defaultLogdir
  }
  if (!parsed.secretdir) {
    parsed.secretdir = defaultSecretdir
  }
  for (const jobName of Object.keys(parsed.jobs)) {
    const job = parsed.jobs[jobName]
    if (!job.env) {
      job.env = {}
    }
    if (typeof job.autostart === 'undefined') {
      job.autostart = true
    }
    if (typeof job.restart === 'undefined') {
      job.restart = true
    }
  }
  return parsed
}

function writeConfig(filename: string, config: Config) {
  fs.writeFileSync(filename, JSON.stringify(config, null, 2))
}

function loadSecrets(config: Config, jobName: string) {
  const secretsFilename = path.resolve(process.cwd(), config.secretdir, `${jobName}.json`)
  if (!fs.existsSync(secretsFilename)) {
    return {}
  }
  try {
    return JSON.parse(fs.readFileSync(secretsFilename, 'utf-8'))
  } catch (error) {
    log(`error reading secrets for ${jobName}:`, error)
    return {}
  }
}

class Coordinator {
  public jobs: Map<string, Job> = new Map()
  constructor(
    public config: Config,
    public commands: { [key: string]: (args: string[]) => unknown },
  ) {}

  private repl?: repl.REPLServer
  private connectedJob?: Job

  applyConfig(config: Config) {
    mkdirp(config.logdir)
    for (const [name, job] of this.jobs.entries()) {
      if (!config.jobs[name]) {
        log('job', name, 'removed from config')
        job.stop()
        this.jobs.delete(name)
      }
    }
    for (const [name, jobConfig] of Object.entries(config.jobs)) {
      if (this.jobs.has(name)) {
        this.jobs.get(name)!.applyConfig(jobConfig)
      } else {
        const logFilename = `${config.logdir}/${name}.log`
        const job: Job = new Job(
          name,
          jobConfig,
          fs.createWriteStream(logFilename),
          () => loadSecrets(this.config, name),
          () => this.connectJobToTerminal(job),
        )
        this.jobs.set(name, job)
        if (jobConfig.autostart) {
          job.start()
        }
      }
    }
    this.config = config
  }

  startRepl(): repl.REPLServer {
    this.repl = repl.start({
      prompt: 'dev-mode> ',
      ignoreUndefined: true,
      eval: (input, _ctx, _file, callback) => {
        this.evalCommand(input).then(
          () => callback(null, undefined),
          error => callback(error, undefined),
        )
      },
    })
    return this.repl
  }

  async evalCommand(input: string) {
    input = input.trim()
    const i = input.indexOf(' ')
    const commandName = i < 0 ? input : input.slice(0, i)
    if (!commandName) {
      return
    }
    const command = this.commands[commandName]
    if (!command) {
      throw 'Unrecognized command: ' + commandName
    }
    return command(i < 0 ? [] : split(input.slice(i + 1)))
  }

  connectJobToTerminal(job: Job) {
    if (this.connectedJob) {
      return Promise.resolve()
    }

    const pty = job.pty!

    console.log('connecting to ', job.name, 'press Ctrl-a followed by d to disconnect')

    this.connectedJob = job

    return new Promise(resolve => {
      // connect job to stdout
      const outputListener = job.pty!.onData(data => process.stdout.write(data))

      const exitListener = pty.onExit(() => {
        disconnect()
      })

      const disconnect = () => {
        ;(this.repl as any)._ttyWrite = ttyWrite
        outputListener.dispose()
        exitListener.dispose()
        this.connectedJob = undefined
        resolve()
      }

      // monkey patch the repl servers ttyWrite to redirect input
      const ttyWrite = (this.repl as any)._ttyWrite

      let commandMode = false
      ;(this.repl as any)._ttyWrite = (
        data: any,
        key?: { sequence: string; name: string; ctrl?: boolean; shift?: boolean },
      ) => {
        if (key && key.ctrl && !key.shift && key.name === 'a') {
          commandMode = !commandMode
          if (commandMode) {
            console.log('entering command mode: press d to disconnect')
          }
        } else if (commandMode) {
          if (key && key.name === 'd') {
            disconnect()
          }
        } else if (!job.pty) {
          // if you're typing while the process exits, we just drop that data
        } else if (data) {
          pty.write(data)
        } else if (key) {
          // we've received an unprintable key
          pty.write(key.sequence)
        }
      }
    })
  }
}

enum JobState {
  Stopped,
  Started,
  Waiting,
  Restarting,
  Stopping,
}

class Job {
  public state: JobState
  public pty?: IPty
  public startedAt?: Date
  public exitCode?: number

  private timeout?: NodeJS.Timeout
  private autoconnect?: RegExp

  constructor(
    public name: string,
    public config: JobConfig,
    private outputStream: fs.WriteStream,
    private getSecrets: () => { [key: string]: string },
    private onAutoConnect: () => void,
  ) {
    this.state = JobState.Stopped
    this.pty = undefined
    this.startedAt = undefined
    this.timeout = undefined
    if (this.config.autoconnect) {
      this.autoconnect = new RegExp(this.config.autoconnect)
    }
  }

  start() {
    if (this.pty) {
      throw new Error('Job already running')
    }

    // Spawn the actual child process
    let secrets
    try {
      secrets = this.getSecrets()
    } catch (error) {
      log(`could not load secrets file for ${this.name}: ${error}`)
    }
    this.pty = spawn('bash', ['-c', this.config.cmd], {
      name: 'xterm-256color',
      env: { ...process.env, ...this.config.env, ...secrets } as JobConfig['env'],
      cwd: process.cwd(),
    })
    const outputListener = this.pty.onData(data => {
      if (this.autoconnect && this.autoconnect.test(data)) {
        this.onAutoConnect()
      }
      this.outputStream.write(data)
    })
    const exitListener = this.pty.onExit(() => {
      outputListener.dispose()
      exitListener.dispose()
    })
    this.startedAt = new Date()
    this.exitCode = undefined
    // this.exitSignal = undefined;
    log('started', this.name, '(PID: ' + this.pty.pid + ')')
    this.pty.on('exit', (code, signal) => this.onExit(code, signal ? signal.toString() : undefined))
    this.state = JobState.Started
    this.pty.pid
  }

  applyConfig(newConfig: JobConfig) {
    this.config = newConfig
    if (
      (newConfig.cmd !== this.config.cmd || !deepEqual(newConfig.env, this.config.env)) &&
      this.state !== JobState.Stopped
    ) {
      this.restart()
    }
  }

  restart() {
    this.state = JobState.Restarting
    this.kill()
  }

  stop() {
    if (this.state === JobState.Stopped || this.state === JobState.Stopping) {
      return
    }
    this.clearTimeout()
    this.state = JobState.Stopping
    return this.kill()
  }

  clearTimeout() {
    if (this.timeout) {
      clearTimeout(this.timeout)
      this.timeout = undefined
    }
  }

  kill() {
    if (!this.pty) {
      return
    }
    this.clearTimeout()
    const process = this.pty
    this.timeout = setTimeout(() => {
      if (this.pty) {
        log(`Sending SIGKILL to job ${this.name} after 3 seconds`)
        this.pty.kill('SIGKILL')
      }
    }, 3000)
    return new Promise(resolve => {
      const exitListener = process.onExit(() => {
        exitListener.dispose()
        resolve()
      })
      process.kill()
    })
  }

  onExit(code?: number, signal?: string) {
    this.clearTimeout()
    log(this.name, 'exited', `(code: ${code}, signal: ${signal})`)

    const nextRestart = this.startedAt!.getTime() + 5000

    this.startedAt = undefined
    this.pty = undefined
    this.exitCode = code

    if (this.state === JobState.Stopping || this.config.restart === false) {
      this.state = JobState.Stopped
      return
    }

    if (Date.now() > nextRestart) {
      this.state = JobState.Restarting
      this.start()
    } else {
      this.state = JobState.Waiting
      setTimeout(() => this.start(), Date.now() - nextRestart)
    }
  }
}

function formatDate(date: Date) {
  const s = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map(n => n.toString().padStart(2, '0'))
    .join('-')
  return `${formatTime(date)} on ${s}`
}

function formatTime(date: Date) {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map(n => n.toString().padStart(2, '0'))
    .join(':')
}

function log(...args: unknown[]) {
  console.log(`[${formatTime(new Date())}]`, ...args)
}

function deepEqual(a: unknown, b: unknown) {
  try {
    assert.deepEqual(a, b)
    return true
  } catch (e) {
    return false
  }
}

function getIn(o: any, path: string[]): any {
  if (path.length === 0) {
    return o
  }
  const [key, ...rest] = path
  if (typeof o[key] !== 'object') {
    return undefined
  }
  return getIn(o[key] as object, rest)
}

function setIn(o: any, path: string[], val: any): any {
  if (path.length === 0) {
    return val
  }
  const [key, ...rest] = path
  const copy: any = { ...o }
  copy[key] = setIn(copy[key], rest, val)
  return copy
}

function mkdirp(dir: string) {
  const parts = path.resolve(process.cwd(), dir).split(path.sep)
  parts.forEach((_, idx) => {
    const parentDir = path.sep + path.join(...parts.slice(1, idx + 1))
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir)
    }
  })
}

function setTerminalTitle(title: string) {
  process.stdout.write(String.fromCharCode(27) + ']0;' + title + String.fromCharCode(7))
}

function main() {
  const configFilename = process.argv[2] || defaultConfigFilename
  if (!fs.existsSync(configFilename)) {
    writeConfig(configFilename, { logdir: defaultLogdir, secretdir: defaultSecretdir, jobs: {} })
  }
  const config = loadConfig(configFilename)

  function jobCommand(fn: (job: Job) => void) {
    return async ([name]: string[]) => {
      if (!name) {
        for (const job of coordinator.jobs.values()) {
          await fn(job)
        }
      } else {
        const job = coordinator.jobs.get(name)
        if (!job) {
          log('no such job:', name)
        } else {
          await fn(job)
        }
      }
    }
  }

  const coordinator: Coordinator = new Coordinator(config, {
    help: ([commandName]) => {
      if (!commandName) {
        console.log(help.help)
        return
      }
      const commandHelp = help[commandName]
      if (commandHelp) {
        console.log(commandHelp)
      } else {
        console.error('No help for command:', commandName)
      }
    },

    // process management
    start: jobCommand(job => {
      if (job.state !== JobState.Stopped) {
        log('job already running:', job.name)
      } else {
        job.start()
      }
    }),
    stop: jobCommand(job => job.stop()),
    status: () => {
      const statuses: { [key: string]: any } = {}
      for (const job of coordinator.jobs.values()) {
        statuses[job.name] = {
          PID: job.pty ? job.pty.pid : undefined,
          state: JobState[job.state],
          'started at': job.startedAt ? formatDate(job.startedAt) : undefined,
          'exit code': typeof job.exitCode === 'number' ? job.exitCode : undefined,
        }
      }
      console.table(statuses)
    },
    connect: async ([jobName]) => {
      if (!jobName) {
        console.error('job name argument is required')
        return
      }
      const job = coordinator.jobs.get(jobName)
      if (!job) {
        console.error('no such job:', jobName)
        return
      }
      if (!job.pty) {
        job.start()
        await new Promise(r => setTimeout(r, 100))
        if (!job.pty) {
          console.error('failed to start job:', jobName)
          return
        }
      }
      await coordinator.connectJobToTerminal(job)
    },

    // job management
    add: argv => {
      const args = minimist(argv, {
        stopEarly: true,
        default: { autostart: true, restart: true },
        alias: { env: 'e' },
        boolean: ['autostart', 'restart'],
      })
      if (args._.length < 2) {
        return coordinator.evalCommand('help add')
      }
      const name = args._[0]
      if (coordinator.config.jobs[name]) {
        console.error('job already defined:', name)
        return
      }
      const env: { [key: string]: string } = {}
      if (typeof args.env === 'string') {
        const [key, val] = args.env.split('=', 2)
        env[key] = val
      } else if (Array.isArray(args.env)) {
        args.env.forEach(pair => {
          const [key, val] = pair.split('=', 2)
          env[key] = val
        })
      }
      const cmd = args._.slice(1)
        .map(s => (s.indexOf(' ') < 0 ? s : JSON.stringify(s)))
        .join(' ')
      updateConfig(['jobs', name], { cmd, autostart: args.autostart, restart: args.restart, env })
    },
    rm: async ([name]) => {
      if (!coordinator.config.jobs[name]) {
        console.error('no such job:', name)
        return
      }
      await coordinator.evalCommand(`stop ${name}`)
      const newJobs = { ...coordinator.config.jobs }
      delete newJobs[name]
      updateConfig(['jobs'], newJobs)
    },

    // config management
    show: ([configPath]) => {
      if (!configPath) {
        console.error('CONFIG_PATH argument is required')
      } else {
        const value = getIn(coordinator.config, configPath.split('.').filter(Boolean))
        if (typeof value === 'object') {
          console.table(value)
        } else {
          console.log(value)
        }
      }
    },
    set: args => {
      if (args.length !== 2) {
        console.error('set requires 2 arguments, a path and a value')
        return
      }
      const [configPath, valueInput] = args
      if (!/(logdir|(jobs\.\w+\.(cmd|autostart|restart|env\.\w+)))/.test(configPath)) {
        console.error('invalid config path:', configPath)
        console.error('try "help config"')
        return
      }
      let value
      try {
        value = JSON.parse(valueInput)
      } catch (error) {
        console.error('value is not valid json:', valueInput)
        return
      }
      updateConfig(configPath.split('.'), value)
    },
    reload: () => {
      try {
        const config = loadConfig(configFilename)
        try {
          coordinator.applyConfig(config)
        } catch (e) {
          log('Error applying config:', e)
        }
      } catch (e) {
        log('Error reading config:', e)
      }
    },
  })

  function updateConfig(configPath: string[], value: any) {
    let newConfig = setIn(coordinator.config, configPath, value)
    try {
      coordinator.applyConfig(newConfig)
    } catch (error) {
      console.error('failed to apply config:', error)
      return
    }
    try {
      writeConfig(configFilename, coordinator.config)
    } catch (error) {
      console.error('failed to update config file:', error)
    }
  }

  const w = fs.watch(configFilename, { persistent: false })
  w.on('change', () => coordinator.evalCommand('reload'))

  coordinator.evalCommand('reload')
  const r = coordinator.startRepl()
  r.on('exit', () => coordinator.evalCommand('stop'))
  process.on('exit', () => coordinator.evalCommand('stop'))
}

main()
