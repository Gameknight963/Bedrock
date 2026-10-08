# Simple Manual Map Injector

Vendored from TheCruZ/Simple-Manual-Map-Injector at commit `c28a45e6ceee9acb1cf25cfeee9bdd707c6a78ea`, under the included MIT license.

Local changes return the mapped base, reduce the wait to four seconds, remove the interactive Debug pause, reject failed imports or DLL initialization, wait for the loader thread before releasing its code, and flush the instruction cache. Header/section clearing is disabled, including its unused temporary buffer. Bedrock retains PE headers and sections, enables unwind registration and section protections, and does not use the header-removal options.
