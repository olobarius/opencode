import { createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { PluginOptions } from "@opencode/plugin/gui"
import {
  pluginIdAvailable,
  runsOn,
  type Bridge,
  type BridgePluginGui,
  type BridgePluginGuis,
  type Entry,
} from "@opencode/plugin/gui/host"
import type { OpenCodeClient } from "@opencode/client/promise"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, useServers } from "@/runtime/server/registry"
import { builtins } from "./builtins"
import { pluginDefinition, webPluginDefinition } from "./module"

/** A plugin's `./gui-experimental` bundle as this window evaluated it, at one revision. */
type Loaded = {
  readonly id: string
  readonly revision: string
  readonly definition: Entry
  readonly options: PluginOptions
}

/** A plugin's GUI as the plugin host runs it: its definition, options, and the client of the server that runs it. */
export type PluginGui = {
  readonly definition: Entry
  readonly options: PluginOptions
  readonly client: () => OpenCodeClient | undefined
}

/**
 * Loads the plugin GUIs main runs. Main alone lists the plugins on the desktop app's own server and reads their
 * `./gui-experimental` bundles; this window evaluates what main sends, so every window and main run the same set. That
 * server already runs the plugins' server entries, so their bundles add no new source of code; other servers' plugins
 * load no GUI.
 *
 * A web tab has no main process. It lists the plugins that the server which served it allows on the web
 * (`experimental.plugin_gui_web`) and reads their bundles itself, with its own credential, applying the id and OS
 * checks main applies on desktop. It runs only their window setups.
 *
 * Mounted below the app's server providers, which the plugin root sits above, for the client of that server; it
 * hands the definitions up through `onChange` rather than the root reading them.
 */
export function PluginGuiLoader(props: {
  /** The desktop bridge; undefined in a web tab. */
  bridge: Bridge | undefined
  /** The GUIs that load, and the ids of plugins whose GUI cannot load because a built-in claims the id. */
  onChange: (plugins: readonly PluginGui[], reserved: readonly string[]) => void
}) {
  const global = useGlobal()
  const servers = useServers()
  const bridge = props.bridge

  const controller = createMemo(() => {
    const conn = global.servers.list().find(bridge ? ServerConnection.builtin : servers.current)

    return conn ? global.serverCtx(ServerConnection.key(conn)) : undefined
  })

  // One evaluation per plugin revision, so an unchanged plugin keeps its definition and the host does not reload it.
  const cache = new Map<string, Loaded>()
  const [guis, setGuis] = createSignal<BridgePluginGuis>()

  if (bridge) {
    onCleanup(
      bridge.on((message) => {
        if (message.type === "pluginGuis") setGuis({ plugins: message.plugins, reserved: message.reserved })
      }),
    )
    // A change main pushed while this request was in flight is newer than its reply.
    void bridge.pluginGuis().then(
      (initial) => setGuis((current) => current ?? initial),
      () => undefined,
    )
  }

  // On the web, lists again on each `plugin.updated` and reconnect, as main does; only the newest reply counts.
  if (!bridge) {
    const listing = { count: 0 }

    createEffect(() => {
      const ctx = controller()

      if (!ctx) return

      const list = () => {
        const count = ++listing.count

        void webGuis(ctx.sdk.api).then(
          (next) => {
            if (count === listing.count) setGuis(next)
          },
          (cause: unknown) => console.error("[plugin]", cause),
        )
      }

      list()
      onCleanup(ctx.sdk.event.on("plugin.updated", list))
      onCleanup(ctx.sdk.event.on("server.connected", list))
    })
  }

  const [found] = createResource(guis, async (input) => {
    const plugins = await Promise.all(input.plugins.map((plugin) => load(plugin, cache, !bridge)))
    const ids = new Set(plugins.map((plugin) => plugin.id))
    cache.forEach((_, id) => {
      if (!ids.has(id)) cache.delete(id)
    })

    // Main leaves out plugins limited to other systems; on the web no OS is known, so only those that list none run.
    return {
      plugins: bridge ? plugins : plugins.filter((plugin) => runsOn(plugin.definition, undefined)),
      reserved: input.reserved,
    }
  })

  // Syncs the loaded plugins out to the plugin host.
  createEffect(() => {
    const latest = found.latest

    if (!latest) return
    // The server that runs the plugin, read each time: it is a new client after that server restarts.
    const client = () => controller()?.sdk.api
    props.onChange(
      latest.plugins.map((plugin) => ({ definition: plugin.definition, options: plugin.options, client })),
      latest.reserved,
    )
  })

  return null
}

/**
 * The plugin GUIs a web tab loads: those its server allows on the web, read as main reads them on desktop. A plugin
 * whose id a built-in claims stays out, and a bundle that cannot be read is left out until the next listing.
 */
async function webGuis(api: OpenCodeClient): Promise<BridgePluginGuis> {
  const listed = (await api.experimental.plugin.web()).data.flatMap((plugin) => (plugin.id ? [plugin.id] : []))
  const reserved = listed.filter((id) => !pluginIdAvailable(id, builtins))

  const plugins = await Promise.all(
    listed
      .filter((id) => !reserved.includes(id))
      .map((id) =>
        api.plugin.gui({ id }).then(
          (bundle) => [{ ...bundle.data, id }],
          (cause: unknown) => {
            console.error("[plugin]", id, cause)

            return []
          },
        ),
      ),
  )

  return { plugins: plugins.flat(), reserved }
}

/** Evaluates a plugin's bundle when its revision is new to this window. */
async function load(plugin: BridgePluginGui, cache: Map<string, Loaded>, web: boolean): Promise<Loaded> {
  const cached = cache.get(plugin.id)

  if (cached?.revision === plugin.revision) return cached

  const next = {
    id: plugin.id,
    revision: plugin.revision,
    options: plugin.options,
    definition: await (web ? webPluginDefinition : pluginDefinition)(plugin.id, plugin.code),
  }

  cache.set(plugin.id, next)

  return next
}
