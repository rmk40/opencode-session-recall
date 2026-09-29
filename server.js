// Local-directory installs on opencode v2 resolve `<dir>/server.*` then
// `<dir>/index.*` and never read package.json, so this shim points them at the
// build. npm installs resolve through `exports` and never see this file (it is
// not in `files`).
export { default } from "./dist/opencode-session-recall.js";
