import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { OpenCode } from "@opencode/client"
import { Effect } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const client = (handler: (request: Request) => Promise<Response>) =>
  OpenCode.make({
    baseUrl: "http://opencode.local",
    fetch: Object.assign((input: string | URL | Request, init?: RequestInit) => handler(new Request(input, init)), {
      preconnect: fetch.preconnect,
    }),
  })

it.live("lists plugin GUIs for the web app only as experimental.plugin_gui_web allows", () =>
  Effect.gen(function* () {
    const dir = (yield* tmpdirScoped("opencode-plugin-web-")).path
    const gui = path.join(dir, "gui")
    const projects = {
      unset: undefined,
      off: false,
      all: true,
      listed: ["opencode-acme-gui"],
      other: ["opencode-other"],
    }

    yield* Effect.promise(async () => {
      await fs.mkdir(path.join(dir, "global"))
      await fs.mkdir(gui)
      await fs.writeFile(
        path.join(gui, "package.json"),
        JSON.stringify({ name: "opencode-acme-gui", exports: { "./gui-experimental": "./gui.cjs" } }),
      )
      await fs.writeFile(path.join(gui, "gui.cjs"), "module.exports = {}")
      await Promise.all(
        Object.entries(projects).map(async ([name, web]) => {
          await fs.mkdir(path.join(dir, name))
          await fs.writeFile(
            path.join(dir, name, "opencode.json"),
            JSON.stringify({ plugins: [gui], experimental: { plugin_gui_web: web } }),
          )
        }),
      )
    })

    const api = client(
      yield* ServerFetch.make({
        app: { version: "test" },
        database: { path: path.join(dir, "opencode.db") },
        config: { directory: path.join(dir, "global"), project: true, claude: false },
        models: { fetch: false },
        fs: { filewatcher: false },
      }),
    )

    yield* Effect.promise(async () => {
      const location = (name: string) => ({ directory: path.join(dir, name) })
      const web = async (name: string) =>
        (await api.experimental.plugin.web({ location: location(name) })).data.map((plugin) => plugin.id)
      // Plugins load in the background, so each Location's plugin is not active the moment it boots.
      const active = async (name: string) => {
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          const plugins = (await api.plugin.list({ location: location(name) })).data
          if (plugins.some((plugin) => plugin.id === "opencode-acme-gui" && plugin.state?.status === "active")) return
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new Error(`opencode-acme-gui did not become active in ${name}`)
      }
      for (const name of Object.keys(projects)) await active(name)

      expect(await web("all")).toEqual(["opencode-acme-gui"])
      expect(await web("listed")).toEqual(["opencode-acme-gui"])
      expect(await web("other")).toEqual([])
      expect(await web("off")).toEqual([])
      expect(await web("unset")).toEqual([])
    })
  }),
)
