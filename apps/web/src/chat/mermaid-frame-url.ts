// The diagram frame's bundle (#182), built first by `vite.frame.config.ts` into dist-frame/ and emitted by the app
// build as a hashed asset. Imported lazily (only when a diagram is drawn), so unit tests never need the build.
import url from "../../dist-frame/mermaid-frame.js?url";

export default url;
