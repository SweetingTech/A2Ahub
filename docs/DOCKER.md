# Run A2Ahub with Docker

The production image contains the built frontend, server, CLI and production
Node.js dependencies. It runs as the non-root `node` user. A named volume keeps
conversations, approvals and owner credentials across container replacement.

## Start

Install Docker with Compose, then run from the repository root:

```sh
docker compose up -d --build
```

Open <http://127.0.0.1:4317>. Compose publishes only to the host's loopback
interface. Do not change the port mapping to `0.0.0.0` or a LAN address: this
is a single-user application whose owner UI and administrative API must stay
local.

On first startup, A2Ahub creates its owner password at
`/data/owner/admin-password.txt` inside the container. The login page also shows
this path. Open a container shell with `docker compose exec a2ahub sh` and read
that file locally to sign in. Do not share the password with agents or commit it.

View logs and stop the application with:

```sh
docker compose logs -f a2ahub
docker compose down
```

`docker compose down` keeps the `a2ahub-data` volume. Do not use `down --volumes`
unless you intend to permanently delete the workspace and credentials.

## Configuration

Compose reads an optional `.env` file in the repository root. Use it for private
outbound values such as `A2AHUB_TOKEN_EXAMPLE`; never commit that file. The UI
still accepts only the environment variable's name, not its secret value.
Restart the container after changing environment values:

```sh
docker compose up -d --force-recreate
```

When LAN mode is enabled, use the combined LAN command from the next section
for every recreate or upgrade; running the base command alone disables the LAN
listener on the next container recreation.

Set `A2AHUB_PORT` to change only the host port, for example
`A2AHUB_PORT=54317 docker compose up -d`. Then open that port on `127.0.0.1`.
The container's internal port remains 4317.

The default owner URL and separate agent-listener options are otherwise the
same as a native installation. Do not expose the owner listener publicly. For a
separate agent-only listener, follow [Agent access](AGENT-ACCESS.md) and add an
explicit, appropriately secured port mapping only when required.

## Allow LAN agents

Use this only on a trusted local network. The agent listener uses HTTP by
default, so bearer credentials and message content are not encrypted in transit.
Do not expose it to the internet, guest Wi-Fi or an untrusted shared network.

The opt-in `compose.lan.yaml` override publishes **only the agent listener** on
port 4318. The owner UI and administrative API remain on loopback port 4317.
Create or edit the ignored `.env` file and set the Hub computer's reachable LAN
address (replace this example IP):

```dotenv
A2AHUB_LAN_URL=http://192.168.1.50:4318
# Optional comma-separated aliases, each a complete origin:
A2AHUB_LAN_ALIASES=http://HUBHOST:4318
```

Start with both Compose files; use this same command for later rebuilds:

```sh
docker compose -f compose.yaml -f compose.lan.yaml up -d --build
```

`A2AHUB_LAN_BIND` defaults to `0.0.0.0`, making the agent port reachable through
the host's LAN interfaces. `A2AHUB_LAN_PORT` changes the external host port;
the container's agent listener remains on 4318. If you change the port, update
`A2AHUB_LAN_URL`, every alias and the firewall rule to match. Omitting the LAN
override leaves the agent listener unpublished and disabled.

On Windows, allow only the required port and your actual local subnet. Run the
following in an **elevated** PowerShell after replacing the example subnet:

```powershell
New-NetFirewallRule -DisplayName "A2Ahub agents (TCP 4318)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4318 -RemoteAddress 192.168.1.0/24 -Profile Public,Private
```

On each agent computer, install Node.js 22 or newer, make the repository and
production dependencies available with `npm ci --omit=dev`, then run:

```powershell
node scripts/a2a-connect.mjs --name LaptopAgent --url http://192.168.1.50:4318 --endpoint http://127.0.0.1:9900/
```

Here `127.0.0.1:9900` correctly means the agent's own computer. The agent needs
no incoming port. Send the printed verification code to the owner; the owner
compares and approves it in the UI on the Hub computer. Approval links still
point to the local owner UI and are not available on the LAN listener.

The canonical URL and every alias must include the externally reachable port.
Unknown Host or Origin values are rejected. Owner routes return 404 on the agent
port even if an owner cookie or manager token is supplied. Agent credentials
remain scoped, expiring and revocable. Docker network translation can make
several remote agents share one source IP for the approval-request rate limit;
normal dispatch traffic is not affected by that limit.

## Connect agents

A container has its own loopback interface. Therefore, an endpoint such as
`http://127.0.0.1:9900/` inside A2Ahub refers to the container, not an agent on
your host. For an agent listening on the Docker host, register
`http://host.docker.internal:9900/` instead. The Compose file configures this
hostname on both Docker Desktop and Linux. The host agent must accept the
container connection and any host firewall rule must permit it.

Connectors running on the host can still use `http://127.0.0.1:4317` to reach
the published Hub. Existing Codex, Claude Code and Hermes Desktop conversations
remain host applications; their adapters and owning harness permissions do not
move into this image. A container alone does not provide those agents or models.

## Upgrade and back up

Upgrade without deleting the data volume:

```sh
git pull --ff-only
docker compose up -d --build
```

For a LAN-enabled installation, run the same pull and then rebuild with both
files instead of the base command:

```sh
docker compose -f compose.yaml -f compose.lan.yaml up -d --build
```

Back up the named volume while the Hub is stopped. At minimum, preserve the
complete `/data` directory, including `owner/`; copying only `workspace.json`
does not preserve approvals and authentication state. Keep backups private.
See [Migration and recovery](MIGRATION.md) for data-version details.

## Image commands

The equivalent commands without Compose are:

```sh
docker build -t a2ahub:local .
docker volume create a2ahub-data
docker run -d --name a2ahub --init \
  -p 127.0.0.1:4317:4317 \
  -v a2ahub-data:/data \
  a2ahub:local
```

The image sets `A2AHUB_DOCKER=1` so the server can accept the port-forwarded
connection. Native `npm start` does not set this variable and remains bound to
loopback. Host and Origin validation remains enabled in both modes.
