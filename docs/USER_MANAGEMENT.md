# Dependency-Track CE — User Management Guide

## Table of Contents
1. [User Types](#1-user-types)
2. [Teams and Permissions](#2-teams-and-permissions)
3. [Creating Users via Script](#3-creating-users-via-script)
4. [Creating Users via UI](#4-creating-users-via-ui)
5. [Managing Teams](#5-managing-teams)
6. [API Keys](#6-api-keys)
7. [LDAP / OIDC Integration](#7-ldap--oidc-integration)

---

## 1. User Types

DependencyTrack supports two user types:

| Type             | Description                                              |
|------------------|----------------------------------------------------------|
| **Managed User** | Username/password stored in DependencyTrack's database   |
| **LDAP User**    | Authenticated via your LDAP/Active Directory server      |
| **OIDC User**    | Authenticated via OpenID Connect (Keycloak, Okta, etc.)  |

For the Community Edition without an identity provider, use **Managed Users**.

---

## 2. Teams and Permissions

DependencyTrack uses **Teams** to grant permissions. Every user must belong to
at least one team to access resources.

### Built-in Permissions

| Permission                  | Description                                  |
|-----------------------------|----------------------------------------------|
| `ACCESS_MANAGEMENT`         | Manage users, teams, permissions             |
| `BOM_UPLOAD`                | Upload SBOMs and BOMs to projects            |
| `PROJECT_CREATION`          | Create new projects                          |
| `PORTFOLIO_MANAGEMENT`      | Manage projects, versions, properties        |
| `SYSTEM_CONFIGURATION`      | Change system-wide configuration             |
| `VIEW_PORTFOLIO`            | Read project list and basic info             |
| `VIEW_VULNERABILITY`        | View vulnerability details                   |
| `VULNERABILITY_ANALYSIS`    | Perform and manage vulnerability analysis    |
| `POLICY_MANAGEMENT`         | Manage compliance policies                   |

### Recommended team structure

```
┌─────────────────────────────────────────────────────────────┐
│ Team: Administrators                                         │
│   Permissions: All                                           │
│   Members: ops team, security leads                         │
├─────────────────────────────────────────────────────────────┤
│ Team: Developers                                             │
│   Permissions: BOM_UPLOAD, VIEW_PORTFOLIO,                  │
│                VIEW_VULNERABILITY, PROJECT_CREATION         │
│   Members: dev teams, CI/CD service accounts                │
├─────────────────────────────────────────────────────────────┤
│ Team: Auditors (read-only)                                   │
│   Permissions: VIEW_PORTFOLIO, VIEW_VULNERABILITY           │
│   Members: compliance, legal, management                    │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Creating Users via Script

The `scripts/create-user.sh` script automates managed user creation.

### Basic usage

```bash
./scripts/create-user.sh \
  --username alice \
  --password "S3cur3P@ss!" \
  --email alice@example.com \
  --fullname "Alice Smith"
```

### Assign user to a team

```bash
./scripts/create-user.sh \
  --username bob \
  --password "S3cur3P@ss!" \
  --team "Developers"
```

### Force password change on first login

```bash
./scripts/create-user.sh \
  --username carol \
  --password "temp123" \
  --force-change
```

### Custom API server

```bash
./scripts/create-user.sh \
  --username dave \
  --password "pass" \
  --api-url http://my-server:8081 \
  --admin-user admin \
  --admin-pass "myAdminPass"
```

### Interactive mode

Run without arguments and the script will prompt for all required values:

```bash
./scripts/create-user.sh
```

### Batch user creation

Create a CSV file `users.csv`:
```
username,password,email,fullname,team
alice,S3cur3P@ss!,alice@example.com,Alice Smith,Developers
bob,S3cur3P@ss!,bob@example.com,Bob Jones,Auditors
carol,temp123,carol@example.com,Carol White,Administrators
```

Then run:
```bash
tail -n +2 users.csv | while IFS=, read -r user pass email name team; do
  ./scripts/create-user.sh \
    --username "$user" \
    --password "$pass" \
    --email    "$email" \
    --fullname "$name" \
    --team     "$team"
done
```

---

## 4. Creating Users via UI

1. Log in to **http://localhost:8080** as `admin`
2. Navigate to **Administration → Access Management → Managed Users**
3. Click **+ Create User**
4. Fill in:
   - **Username** — must be unique
   - **Full Name** — display name
   - **Email** — optional but recommended for notifications
   - **New Password / Confirm Password**
   - **Force Password Change** — check this for temporary passwords
5. Click **Create**
6. To assign the user to a team:
   - Go to **Administration → Access Management → Teams**
   - Click the target team
   - Under **Users**, click **+ Add User**
   - Select the user and click **Add**

---

## 5. Managing Teams

### Create a team via API

```bash
# Obtain a JWT token first
TOKEN=$(curl -sf \
  -X POST http://localhost:8081/api/v1/user/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=admin" \
  --data-urlencode "password=<your-pass>" )

# Create the team
curl -s \
  -X PUT http://localhost:8081/api/v1/team \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Developers"}' | jq .
```

### Assign permissions to a team

```bash
# Get team UUID
TEAM_UUID=$(curl -s -H "Authorization: Bearer $TOKEN" \
  http://localhost:8081/api/v1/team | jq -r '.[] | select(.name=="Developers") | .uuid')

# Add permissions
for PERM in BOM_UPLOAD VIEW_PORTFOLIO VIEW_VULNERABILITY PROJECT_CREATION; do
  curl -s -X POST \
    "http://localhost:8081/api/v1/permission/${PERM}/team/${TEAM_UUID}" \
    -H "Authorization: Bearer $TOKEN" -o /dev/null
  echo "Added: $PERM"
done
```

---

## 6. API Keys

API keys are attached to **Teams**, not individual users. They are used by:
- CI/CD pipelines uploading SBOMs
- The custom dashboard (for live data)
- Any script or integration using the REST API

### Create an API key

1. **Administration → Access Management → Teams**
2. Click the team (e.g., "Developers")
3. Under **API Keys**, click **+ Generate API Key**
4. Copy and store the key — it is shown only once

### Use an API key

```bash
# In HTTP headers
curl -H "X-Api-Key: odt_xxxxxxxxxxxxxxxx" \
  http://localhost:8081/api/v1/project | jq .

# In scripts — set in .env
DT_API_KEY=odt_xxxxxxxxxxxxxxxx
```

### Rotate an API key

1. Navigate to the team's API Keys section
2. Click the delete icon on the existing key
3. Generate a new key
4. Update all services using the old key

---

## 7. LDAP / OIDC Integration

> Available in Community Edition.

### LDAP

Add to `docker-compose.yml` under `dtrack-apiserver` → `environment`:

```yaml
ALPINE_LDAP_ENABLED:        "true"
ALPINE_LDAP_SERVER_URL:     "ldap://ldap.example.com:389"
ALPINE_LDAP_BASEDN:         "dc=example,dc=com"
ALPINE_LDAP_BIND_USERNAME:  "cn=dt-service,dc=example,dc=com"
ALPINE_LDAP_BIND_PASSWORD:  "ldap-service-password"
ALPINE_LDAP_AUTH_USERNAME_FORMAT: "{0}@example.com"
ALPINE_LDAP_GROUPS_FILTER:  "(&(objectClass=group)(member={0}))"
```

### OIDC (Keycloak, Okta, Azure AD, etc.)

```yaml
ALPINE_OIDC_ENABLED:             "true"
ALPINE_OIDC_ISSUER:              "https://keycloak.example.com/realms/myRealm"
ALPINE_OIDC_CLIENT_ID:           "dependency-track"
ALPINE_OIDC_USER_PROVISIONING:   "true"
ALPINE_OIDC_TEAM_SYNCHRONIZATION: "true"
```

See [OIDC docs](https://docs.dependencytrack.org/getting-started/openidconnect-configuration/) for full details.
