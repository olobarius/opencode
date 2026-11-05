import { ArtifactEndpoints } from "./artifact.js"
import { BlobGetEndpoint } from "./blob.js"
import { AutomationEndpoints } from "./automation.js"
import { JobEndpoints } from "./job.js"
import { MediaGetEndpoint } from "./media.js"
import { PersistentPtyGroup } from "./persistent-pty.js"
import { PluginWebEndpoint } from "./plugin.js"

/** `server.experimental`: routes under /api/experimental, without compatibility guarantees. */
export const ExperimentalGroup = PersistentPtyGroup.add(
  MediaGetEndpoint,
  BlobGetEndpoint,
  PluginWebEndpoint,
  ...AutomationEndpoints,
  ...ArtifactEndpoints,
  ...JobEndpoints,
)
