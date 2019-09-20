#!/usr/bin/env node
import assert from 'assert'
import fs from 'fs'
import path from 'path'
import repl from 'repl'
import { spawn, IPty } from 'node-pty'
import { disconnect } from 'cluster'

const help: { [topic: string]: string } = {}
help.help = `
dev-mode is a REPL for running subprocesses. Think of it like an interactive
Procfile, or docker-compose without docker. It's meant to run continuously in a
terminal and allow you to quickly start & stop processes in a reproducible way.

status [JOB_NAME]       Show the status of your job(s).
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
status [JOB_NAME]

Show the status of all jobs by default, or the specified job if a job name is given.
`

help.start = `
start [JOB_NAME]

Starts a job, or all jobs if no JOB_NAME is specified.
`

help.stop = `
stop [JOB_NAME]

Stops a job, or all jobs if no JOB_NAME is specified.
`

help.add = `
add JOB_NAME COMMAND

Adds a job to your config file. Everything following the job name will be
treated as the command to run. The job will be started immediately and the
config value for jobs.$JOB_NAME.autostart will be set to true.

Examples:

    add job rails bin/rails server
    add job redis docker kill my-redis; docker run --rm --name my-redis -i redis
`

help.rm = `
rm JOB_NAME

Removes a job from your config. Warning: there is no undo! Usually you want the
stop command instead of this one.
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
  jobs.$job_name.autostart        Whether this job starts with dev-mode.
`

interface Config {
  logdir: string
  jobs: {
    [jobName: string]: JobConfig | undefined
  }
}

interface JobConfig {
  cmd: string
  autostart?: boolean
  restart?: boolean
  env: { [variable: string]: string }
}

class Coordinator {
  public config: Config = { logdir: 'log', jobs: {} }
  public jobs: Map<string, Job> = new Map()

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
        this.jobs.get(name)!.applyConfig(jobConfig!)
      } else {
        const job = new Job(name, jobConfig!, fs.createWriteStream(`${config.logdir}/${name}.log`))
        this.jobs.set(name, job)
        if (jobConfig!.autostart) {
          job.start()
        }
      }
    }
    this.config = config
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
  public process?: IPty
  public startedAt?: Date
  public exitCode?: number
  // private exitSignal?: string;

  private timeout?: NodeJS.Timeout

  constructor(public name: string, public config: JobConfig, private outputStream: fs.WriteStream) {
    this.state = JobState.Stopped
    this.process = undefined
    this.startedAt = undefined
    this.timeout = undefined
  }

  start() {
    if (this.process) {
      throw new Error('Job already running')
    }

    // Spawn the actual child process
    this.process = spawn('bash', ['-c', this.config.cmd], {
      name: 'xterm-256color',
      env: { ...process.env, ...this.config.env } as JobConfig['env'],
      cwd: process.cwd(),
    })
    const outputListener = this.process.onData(data => this.outputStream.write(data))
    const exitListener = this.process.onExit(() => {
      outputListener.dispose()
      exitListener.dispose()
    })
    this.startedAt = new Date()
    this.exitCode = undefined
    // this.exitSignal = undefined;
    log('started', this.name, '(PID: ' + this.process.pid + ')')
    this.process.on('exit', (code, signal) =>
      this.onExit(code, signal ? signal.toString() : undefined),
    )
    this.state = JobState.Started
    this.process.pid
  }

  applyConfig(newConfig: JobConfig) {
    if (!deepEqual(newConfig, this.config)) {
      this.config = newConfig
      if (this.state !== JobState.Stopped) {
        this.restart()
      }
    }
  }

  restart() {
    this.state = JobState.Restarting
    this.kill()
  }

  stop() {
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
    if (!this.process) {
      return
    }
    this.clearTimeout()
    const process = this.process
    this.timeout = setTimeout(() => {
      if (this.process) {
        log(`Sending SIGKILL to job ${this.name} after 10 seconds`)
        this.process.kill('SIGKILL')
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
    this.process = undefined
    this.exitCode = code
    // this.exitSignal = signal;
    if (this.state === JobState.Stopping || this.config.restart === false) {
      this.state = JobState.Stopped
      return
    }
    const nextRestart = this.startedAt!.getTime() + 5000
    this.startedAt = undefined

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

function main() {
  const configFilename = process.argv[2] || '.dev-mode.json'

  const coordinator = new Coordinator()

  function jobCommand(fn: (job: Job) => void) {
    return async (name?: string) => {
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

  function updateConfig(configPath: string[], value: any) {
    let newConfig = setIn(coordinator.config, configPath, value)
    try {
      coordinator.applyConfig(newConfig)
    } catch (error) {
      console.error('failed to apply config:', error)
      return
    }
    try {
      fs.writeFileSync(configFilename, JSON.stringify(coordinator.config, null, 2))
    } catch (error) {
      console.error('failed to update config file:', error)
    }
  }

  let connectedJob: undefined | Job

  const commands = {
    help: (commandName?: string) => {
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
          PID: job.process ? job.process.pid : undefined,
          state: job.state,
          'started at': job.startedAt ? formatDate(job.startedAt) : undefined,
          'exit code': typeof job.exitCode === 'number' ? job.exitCode : undefined,
        }
      }
      console.table(statuses)
    },
    connect: async (jobName?: string) => {
      if (!jobName) {
        console.error('job name argument is required')
        return
      }
      const job = coordinator.jobs.get(jobName)
      if (!job) {
        console.error('no such job:', jobName)
        return
      }
      if (!job.process) {
        job.start()
        await new Promise(r => setTimeout(r, 10))
        if (!job.process) {
          console.error('failed to start job:', jobName)
          return
        }
      }

      console.log('connecting to ', jobName, 'press Ctrl-a followed by d to disconnect')

      connectedJob = job
      return new Promise(resolve => {
        // connect job to stdout
        const outputListener = job.process!.onData(data => process.stdout.write(data))

        const exitListener = job.process!.onExit(() => {
          disconnect()
        })

        const disconnect = () => {
          ;(r as any)._ttyWrite = ttyWrite
          outputListener.dispose()
          exitListener.dispose()
          resolve()
        }

        // monkey patch the repl servers ttyWrite to redirect input
        const ttyWrite = (r as any)._ttyWrite

        let commandMode = false
        ;(r as any)._ttyWrite = (
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
          } else if (!job.process) {
            // if you're typing while the process exits, we just drop that data
          } else if (data) {
            job.process!.write(data)
          } else if (key) {
            // we've received an unprintable key
            // job.process!
            job.process!.write(key.sequence)
          }
        }
      })
    },

    // job management
    add: (name: string, ...rest: string[]) => {
      if (coordinator.config.jobs[name]) {
        console.error('job already defined:', name)
        return
      }
      const cmd = rest.join(' ')
      updateConfig(['jobs', name], { cmd, autostart: true })
    },
    rm: (name: string) => {
      if (!coordinator.config.jobs[name]) {
        console.error('no such job:', name)
        return
      }
      commands.stop(name)
      const newJobs = { ...coordinator.config.jobs }
      delete newJobs[name]
      updateConfig(['jobs'], newJobs)
    },

    // config management
    show: (configPath?: string) => {
      if (!configPath) {
        console.log(coordinator.config)
      } else {
        console.table(getIn(coordinator.config, configPath.split('.').filter(Boolean)))
      }
    },
    set: (configPath: string, ...rest: string[]) => {
      if (!configPath || rest.length === 0) {
        console.error('set requires 2 arguments, a path and a value')
        return
      }
      if (!/(logdir|(jobs\.\w+\.(cmd|autostart|restart|env\.\w+)))/.test(configPath)) {
        console.error('invalid config path:', configPath)
        console.error('try "help config"')
        return
      }
      let value
      try {
        value = JSON.parse(rest.join(' '))
      } catch (error) {
        console.error('value is not valid json:', rest.join(' '))
        return
      }
      updateConfig(configPath.split('.'), value)
    },
    reload: () => {
      if (!fs.existsSync(configFilename)) {
        fs.writeFileSync(configFilename, JSON.stringify({ logdir: 'logs', jobs: {} }, null, 2))
      }
      try {
        const config = JSON.parse(fs.readFileSync(configFilename, 'utf8'))
        try {
          coordinator.applyConfig(config)
        } catch (e) {
          log('Error applying config:', e)
        }
      } catch (e) {
        log('Error reading config:', e)
      }
    },
  }

  commands.reload()

  function isCommand(s: string): s is keyof typeof commands {
    return commands.hasOwnProperty(s)
  }

  const w = fs.watch(configFilename, { persistent: false })
  w.on('change', commands.reload)

  const r = repl.start({
    prompt: 'dev-mode> ',
    ignoreUndefined: true,
    completer: (input: string) => {
      const commandHits = Object.keys(commands).filter(command => command.startsWith(input))
      if (commandHits.length) {
        return [commandHits, input]
      }
      return [[], input]
    },

    eval: (input, ctx, file, callback) => {
      const [command, ...args] = input.split(/\s+/).filter(Boolean)
      if (!command) {
        callback(null, undefined)
        return
      }
      if (!isCommand(command)) {
        console.error('unknown command:', command)
      } else {
        const fn = commands[command] as ((...args: string[]) => unknown)
        Promise.resolve(fn(...args)).then(
          () => callback(null, undefined),
          err => callback(err, undefined),
        )
      }
    },
  })

  r.on('exit', () => commands.stop())
  process.on('exit', () => commands.stop())
}

main()
