/**
 *   import "@here.build/arrival-chain/backends/providers/register";
 *
 * Registers the @host/providers tier-dispatching backend under the
 * "providers" provider name. Programs that want it use mappings like:
 *
 *   project.setModel("fast", "providers", "fast");
 *
 * — i.e. the "modelName" half is the tier name passed through to
 * chatComplete.
 */
import { Project } from "../../project.js";
import { tieredProvidersBackend } from "../providers.js";

Project.registerBackend("providers", tieredProvidersBackend());
