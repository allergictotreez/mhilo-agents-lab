# mhilo agents

**Every Claude Code session on your computer, drawn as a lab:** who is working on what, where, and for
how long.

Each project is a wing, each area of work is a pod, each session is a lab worker, and every agent a
session sends out is a worker who walks to the pod it is working in. Busy workers stand at their
pod's bench; idle ones wait in the hallway. Click any worker for its title, model, time on task,
tokens, cost and the tool it is using right now.

See it running with made-up sessions at [agents.mhilo.com](https://agents.mhilo.com).

It runs on your computer and stays there: a small Node process reads Claude Code's session files
and serves the lab at `http://127.0.0.1:8777/`, reachable from this computer only. Nothing is sent anywhere
unless you set up your own hosted copy (see the end of this page).

## What you need

- **macOS, Windows or Linux.** Built and tested on macOS. Windows and Linux run the same code, and
  its tests include sessions with Windows paths, but it has not been tried on a real Windows or
  Linux machine yet. If something looks wrong there, please open an issue.
- **Node.js 20 or newer.** Check with `node --version`. There is nothing to `npm install`: the
  collector uses only Node's standard library, and the page's one library (three.js) is included.
- **Claude Code**, with a session or two running.

## Set it up

**1. Download it.**

```sh
git clone https://github.com/allergictotreez/mhilo-agents-lab.git
cd mhilo-agents-lab
```

Or use **Code → Download ZIP** on GitHub and unzip it somewhere you will keep it.

**2. Start it.**

```sh
npm start
```

It prints `local view on http://127.0.0.1:8777/`. Leave it running.

**3. Open the lab.** Go to [http://127.0.0.1:8777/](http://127.0.0.1:8777/). Your sessions appear
in the banner at the top within a few seconds. Click the banner to open the lab full screen; Esc
closes it. Add `?demo=1` to the address to see the simulated lab instead.

That is all it needs. The steps below are optional.

## Keep it running

To start the collector at login and keep it running in the background:

```sh
npm run install-agent
```

This is macOS only. On Windows or Linux, run `npm start` when you want the lab, or add it to your
startup apps.

Run it from the folder you will keep: the background copy runs the files where they are. Its log is
`~/Library/Logs/mhilo-agents/collector.log`. To stop it starting at login:

```sh
npm run uninstall-agent
```

## Give a project its own wing

A project with no settings of its own goes to the **Workshop** wing, with three pods: Build,
Design and Research. To give a project its own wing, with pods named after its work:

1. Copy `lab/_template.json` to `lab/<your-project>.json`.
2. Set `id`, `label` and `color`, and list the project's folder names under `match.cwd`.
   Worktrees count: `"my-app-*"` matches `my-app-feature`.
3. List 3 to 9 `areas`. Each one is a pod: `keywords` are matched against session titles and
   agent descriptions, and `paths` against the files a session has been reading and editing.

The collector picks up the new file within a few seconds, with no restart. A file with fewer than
three areas is ignored, and its sessions stay in the Workshop.

## What it reads, and what it keeps

It reads Claude Code's session list (`~/.claude/sessions/*.json`), its state files, and the end of
each session's transcript. From those it keeps only:

- session titles and agent descriptions
- tool names, with a hint of up to 60 characters: a command's first words or a file's name
- token counts, cost and timestamps

It never keeps prompt text, replies, file contents, paths outside the project folder, or keys. The
local server answers only on `127.0.0.1`.

## If something is off

- **Port 8777 is taken:** `AGENTS_PORT=8790 npm start`, then open `http://127.0.0.1:8790/`. In
  Windows PowerShell: `$env:AGENTS_PORT=8790; npm start`.
- **Claude Code keeps its files somewhere else:** `CLAUDE_HOME=/path/to/.claude npm start`
  (PowerShell: `$env:CLAUDE_HOME='C:\path\to\.claude'; npm start`).
- **The lab is empty:** start a Claude Code session; the lab only shows sessions that are running.
- **Sessions land in the Workshop:** that project has no wing of its own yet (see above).

## Put it online (optional)

You can host your own copy so you can check on your sessions from your phone. It needs a web host
with **PHP 8.1 or newer**, **HTTPS**, and **SSH** access, and **PHP on your computer** as well
(on a Mac, `brew install php`): the setup script uses it to hash the password before it leaves
your computer. The script is a shell script: on Windows, run it from WSL or Git Bash.

1. Upload the `site/` folder to the folder your domain serves, for example with
   `rsync -rL --exclude=/data/ site/ you@host:path/to/site/`. The `.htaccess` file must go too: it
   keeps the password file and the stored data off the web.
2. Set the site password and connect your computer to the site. This asks for the password twice and
   never shows it:

   ```sh
   SITE_URL=https://agents.example.com SSH_HOST=host.example.com SSH_PORT=22 SSH_USER=you \
   DOC_ROOT=/path/to/site sh tools/set-secret.sh
   ```

   Add `SSH_KEY=~/.ssh/<key>` if your host's key is not the default one.

   It stores a hash of the password and a push token on the server, and saves the token and the
   site's address in `~/.config/mhilo-agents/` on your computer.
3. Restart the collector (`npm run install-agent` again, or stop and rerun `npm start`). It now
   sends each project's summary to your site when something changes, and at least once a minute.

Signed in, your site shows your sessions. Anyone else sees the demo. Five wrong passwords lock
sign-in for fifteen minutes.

## License

MIT, see [LICENSE](LICENSE). The page includes three.js, also MIT
([site/vendor/three/LICENSE](site/vendor/three/LICENSE)).
