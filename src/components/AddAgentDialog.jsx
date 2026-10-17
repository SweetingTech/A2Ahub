import { ChevronRight } from "lucide-react";
import { Dialog } from "../workspace.jsx";

// AddAgentDialog — the modal shown by "Connect an endpoint". The host owns
// the `url` / `tokenEnv` state and the `addAgent` submit handler.
export function AddAgentDialog({
  modal,
  setModal,
  url,
  setUrl,
  tokenEnv,
  setTokenEnv,
  error,
  busy,
  addAgent,
}) {
  if (!modal) return null;
  return (
    <Dialog
      title="Connect an endpoint"
      onClose={() => setModal(false)}
      initialFocus="#endpoint"
    >
      <p>Discover an agent from its A2A endpoint.</p>
      <form onSubmit={addAgent}>
        <label htmlFor="endpoint">Agent endpoint</label>
        <input
          id="endpoint"
          type="url"
          required
          placeholder="http://127.0.0.1:9900/"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <label htmlFor="credential">
          Credential environment variable <small>(optional)</small>
        </label>
        <input
          id="credential"
          placeholder="A2AHUB_TOKEN_MY_AGENT"
          value={tokenEnv}
          onChange={(e) => setTokenEnv(e.target.value)}
        />
        <p className="hint">
          For bearer authentication, set this variable on the server before
          starting A2Ahub. Enter the variable name here, never the secret.
        </p>
        {error && (
          <p className="banner" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? "Discovering…" : "Discover & connect"}
          <ChevronRight size={16} />
        </button>
      </form>
    </Dialog>
  );
}
