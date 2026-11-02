#!/usr/bin/env node
import { resolve } from 'node:path';
import { Controller } from '../src/controller.mjs';
import { resolveRuntime } from '../src/plan.mjs';
import { readJson } from '../src/storage.mjs';
import { listImages } from '../src/image.mjs';
import { resolveRoot } from '../src/settings.mjs';

const argv = process.argv.slice(2);
const at = argv.indexOf('--root');
let root;
if (at !== -1) {
  if (!argv[at + 1]) throw new Error('--root requires a directory');
  root = resolve(argv[at + 1]); argv.splice(at, 2);
}
const [command, argument] = argv;
// --root wins; otherwise follow the panel override, plugin config and env.
const controller = new Controller({ root: root ?? resolveRoot() });
const print = value => console.log(JSON.stringify(value, null, 2));
try {
  switch (command) {
    case 'plan': if (!argument) throw new Error('plan requires a JSON file'); print(await controller.addPlan(argument)); break;
    case 'plans': print(await controller.plans()); break;
    case 'start': print(await controller.start(argument)); break;
    case 'run': {
      const run = await controller.start(argument);
      let interrupted = false;
      const stop = () => { interrupted = true; controller.cancel(run.id).catch(() => {}); };
      process.on('SIGINT', stop); process.on('SIGTERM', stop);
      try {
        const result = await controller.wait(run.id);
        print(await controller.export(run.id));
        if (result.state !== 'completed' || result.cleanup !== 'succeeded') process.exitCode = interrupted ? 130 : 1;
      } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
      break;
    }
    case 'open': {
      const run = await controller.start(argument);
      // The URL appears once the web server listens; poll briefly instead of waiting for destroy.
      const deadline = Date.now() + 60000;
      let status = run;
      while (Date.now() < deadline && !status.url && ['queued', 'preparing', 'open'].includes(status.state)) {
        await new Promise(resolve => setTimeout(resolve, 250));
        status = await controller.status(run.id);
      }
      print({ id: run.id, state: status.state, url: status.url ?? null });
      if (!status.url) process.exitCode = 1;
      break;
    }
    case 'destroy': print(await controller.destroy(argument)); break;
    case 'images': print(await listImages(await controller.root())); break;
    case 'status': print(await controller.status(argument)); break;
    case 'list': print(await controller.list()); break;
    case 'cancel': print(await controller.cancel(argument)); break;
    case 'export': print(await controller.export(argument)); break;
    case 'recover': print(await controller.recover(argument)); break;
    case 'doctor': {
      const runtime = resolveRuntime(), pkg = await readJson(runtime.packagePath);
      print({ node: process.version, dsh: pkg.version, runtime: runtime.entry, stateRoot: await controller.root(), platform: process.platform });
      break;
    }
    case undefined: case 'help': case '--help':
      console.log('dsh-test [--root DIRECTORY] <command> [argument]\n\nplan FILE   Register a trusted JSON plan\nplans       List approved plans\nstart NAME  Start in background\nrun NAME    Start and wait (Ctrl+C requests cleanup)\nopen NAME   Open an interactive run and print its URL\ndestroy ID  Destroy a parked interactive run\nimages      List cached install images\nstatus ID   Inspect state\nlist        List runs\ncancel ID   Request cancellation\nexport ID   Get evidence directory\nrecover ID  Clean an interrupted run after process absence checks\ndoctor      Check runtime and state root');
      break;
    default: throw new Error(`Unknown command: ${command}`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
