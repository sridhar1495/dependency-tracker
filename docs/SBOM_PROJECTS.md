# Dependency-Track CE — SBOM & Project Management Guide

## Table of Contents
1. [What is an SBOM?](#1-what-is-an-sbom)
2. [Supported Formats](#2-supported-formats)
3. [Generating SBOMs](#3-generating-sboms)
4. [Adding a Project via Script](#4-adding-a-project-via-script)
5. [Bulk Upload](#5-bulk-upload)
6. [Adding a Project via UI](#6-adding-a-project-via-ui)
7. [CI/CD Integration](#7-cicd-integration)
8. [Project Hierarchy (Parent/Child)](#8-project-hierarchy-parentchild)
9. [Tags and Properties](#9-tags-and-properties)
10. [Understanding Analysis Results](#10-understanding-analysis-results)

---

## 1. What is an SBOM?

A **Software Bill of Materials (SBOM)** is a formal, machine-readable inventory
of the software components in a product, including their versions, licenses, and
known vulnerabilities.

DependencyTrack ingests SBOMs and continuously monitors each component against
multiple vulnerability databases:
- NVD (National Vulnerability Database)
- GitHub Security Advisories
- OSS Index (Sonatype)
- VulnDB (commercial, optional)
- Snyk (commercial, optional)

---

## 2. Supported Formats

| Format         | Extension              | Notes                                    |
|----------------|------------------------|------------------------------------------|
| CycloneDX JSON | `.json`, `.cdx.json`   | **Recommended** — most feature-rich      |
| CycloneDX XML  | `.xml`, `.cdx.xml`     | Fully supported                          |
| SPDX JSON      | `.spdx.json`           | Supported (limited metadata mapping)     |
| SPDX RDF       | `.spdx.rdf`            | Supported                                |

> **Note:** Archive files (`.tar`, `.zip`, `.gz`) are **not** accepted.
> Extract the SBOM file from the archive before uploading:
> ```bash
> tar -xf cs-api-gateway-internal-springcloud_1.4.0.tar
> ./scripts/upload-sbom.sh --file cs-api-gateway-internal-springcloud_1.4.0.cdx.json
> ```

**CycloneDX** is the recommended format as it provides:
- Component hashes (SHA-1, SHA-256)
- PURL (Package URL) for precise matching
- VEX (Vulnerability Exploitability eXchange) statements
- Composition completeness assertions

---

## 3. Generating SBOMs

### Java / Maven

```bash
# CycloneDX Maven plugin
mvn org.cyclonedx:cyclonedx-maven-plugin:makeBom

# Output: target/bom.json
```

### Java / Gradle

```groovy
// build.gradle
plugins {
    id 'org.cyclonedx.bom' version '1.8.2'
}

cyclonedxBom {
    includeConfigs = ["runtimeClasspath"]
    outputName = "bom"
    outputFormat = "json"
}
```

```bash
./gradlew cyclonedxBom
# Output: build/reports/bom.json
```

### Node.js / npm

```bash
npm install -g @cyclonedx/cyclonedx-npm
cyclonedx-npm --output-format JSON --output-file bom.json
```

### Node.js / yarn

```bash
npm install -g @cyclonedx/cyclonedx-yarn
cyclonedx-yarn --output-format JSON --output-file bom.json
```

### Python / pip

```bash
pip install cyclonedx-bom
cyclonedx-py pip -o bom.json --format JSON
```

### Python / Poetry

```bash
cyclonedx-py poetry -o bom.json --format JSON
```

### Go

```bash
go install github.com/CycloneDX/cyclonedx-gomod/cmd/cyclonedx-gomod@latest
cyclonedx-gomod app -json -output bom.json .
```

### .NET / NuGet

```bash
dotnet tool install --global CycloneDX
dotnet CycloneDX . -o . -fn bom.json -j
```

### Docker images (Syft)

```bash
# Install Syft
curl -sSfL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s

# Generate SBOM from a Docker image
syft my-image:latest -o cyclonedx-json > bom.json
```

### Scanning a running container or filesystem

```bash
syft /path/to/rootfs -o cyclonedx-json > bom.json
```

---

## 4. Adding a Project via Script

### Single upload (auto-detect project name from SBOM)

```bash
./scripts/upload-sbom.sh --file ./my-project/target/bom.json
```

### Specify project name and version

```bash
./scripts/upload-sbom.sh \
  --file    ./bom.json \
  --project "payment-service" \
  --version "2.3.1"
```

### Add tags

```bash
./scripts/upload-sbom.sh \
  --file    ./bom.json \
  --project "payment-service" \
  --version "2.3.1" \
  --tags    "java,microservice,pci-dss"
```

### Upload to an existing project UUID

```bash
# First get the UUID
curl -s -H "X-Api-Key: $DT_API_KEY" \
  "http://localhost:8081/api/v1/project?name=payment-service" | jq -r '.[0].uuid'

# Then upload with the UUID already known
./scripts/upload-sbom.sh \
  --file ./bom.json \
  --project "payment-service" \
  --version "2.3.1"
```

### Options reference

| Option          | Description                                              |
|-----------------|----------------------------------------------------------|
| `-f, --file`    | Path to SBOM file (required)                             |
| `-n, --project` | Project name (auto-detected from SBOM if omitted)        |
| `-v, --version` | Project version (auto-detected from SBOM if omitted)     |
| `--parent`      | Parent project UUID for hierarchical projects            |
| `--tags`        | Comma-separated tags                                     |
| `--admin-user`  | Admin username (default: from `.env`)                    |
| `--admin-pass`  | Admin password (default: from `.env`)                    |
| `--api-url`     | API base URL (default: from `.env`)                      |

---

## 5. Bulk Upload

### Upload all JSON SBOMs from a directory

```bash
./scripts/bulk-upload-sbom.sh --dir ./sboms/
```

### Filter by file pattern

```bash
./scripts/bulk-upload-sbom.sh \
  --dir     ./sboms/ \
  --pattern "*.json" \
  --tags    "release-2024-q1"
```

### Dry run (preview only)

```bash
./scripts/bulk-upload-sbom.sh --dir ./sboms/ --dry-run
```

### Directory structure example

```
sboms/
├── payment-service-2.3.1.json
├── auth-gateway-1.5.0.json
├── user-profile-api-3.0.0.json
└── ...
```

The script will upload each file, creating projects automatically if they don't
exist (name is read from the SBOM metadata).

---

## 6. Adding a Project via UI

1. Log in to **http://localhost:8080**
2. Navigate to **Projects** (top menu)
3. Click **+ Create Project**
4. Fill in:
   - **Name** — project/service name
   - **Version** — semantic version (e.g. `1.2.3`)
   - **Description** — optional
   - **Parent** — for microservice hierarchies
   - **Tags** — for filtering/grouping
   - **Classifier** — Library, Application, Container, etc.
5. Click **Create**
6. Open the project → click **Upload BOM**
7. Choose your SBOM file → click **Upload**
8. DependencyTrack will analyse the components in the background (1–5 minutes)

---

## 7. CI/CD Integration

### GitHub Actions

```yaml
# .github/workflows/sbom.yml
name: SBOM Upload

on:
  push:
    branches: [main]

jobs:
  sbom:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Generate SBOM
        run: mvn org.cyclonedx:cyclonedx-maven-plugin:makeBom

      - name: Upload to Dependency-Track
        uses: DependencyTrack/gh-upload-sbom@v3
        with:
          serverHostname: ${{ secrets.DT_HOST }}
          apiKey:          ${{ secrets.DT_API_KEY }}
          project:         ${{ secrets.DT_PROJECT_UUID }}
          bomFilename:     target/bom.json
          autoCreate:      true
          projectName:     my-service
          projectVersion:  ${{ github.ref_name }}
```

### GitLab CI

```yaml
# .gitlab-ci.yml
upload-sbom:
  stage: deploy
  image: alpine:3.19
  before_script:
    - apk add --no-cache curl
  script:
    - |
      # Use multipart POST — avoids base64 shell variable size limits on large SBOMs
      curl -sf \
        -X POST "${DT_API_URL}/api/v1/bom" \
        -H "X-Api-Key: ${DT_API_KEY}" \
        -F "projectName=${CI_PROJECT_NAME}" \
        -F "projectVersion=${CI_COMMIT_REF_NAME}" \
        -F "autoCreate=true" \
        -F "bom=@target/bom.json"
  only:
    - main
```

### Jenkins

```groovy
pipeline {
    agent any
    stages {
        stage('Upload SBOM') {
            steps {
                sh '''
                # Use multipart POST — avoids base64 shell variable size limits on large SBOMs
                curl -sf \
                  -X POST "${DT_API_URL}/api/v1/bom" \
                  -H "X-Api-Key: ${DT_API_KEY}" \
                  -F "projectName=${JOB_NAME}" \
                  -F "projectVersion=${BUILD_NUMBER}" \
                  -F "autoCreate=true" \
                  -F "bom=@target/bom.json"
                '''
            }
        }
    }
}
```

> **Why multipart POST?** The older `PUT /api/v1/bom` approach required
> base64-encoding the SBOM into a shell variable before passing it to curl.
> For large SBOMs (e.g. container image SBOMs with thousands of components)
> this exceeds the OS `ARG_MAX` limit and fails with *"Argument list too long"*.
> The multipart `POST /api/v1/bom` endpoint streams the file directly from disk
> and is supported by all DependencyTrack versions. `upload-sbom.sh` uses this
> approach internally.

---

## 8. Project Hierarchy (Parent/Child)

Organise related projects under a parent for portfolio-level visibility:

```
Portfolio
└── e-commerce-platform           (parent project)
    ├── payment-service           (child)
    ├── checkout-flow             (child)
    ├── product-catalog           (child)
    └── auth-gateway              (child)
```

### Create parent project

```bash
# Via API
TOKEN=$(curl -sf -X POST http://localhost:8081/api/v1/user/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=admin" --data-urlencode "password=<pass>")

PARENT_UUID=$(curl -sf \
  -X PUT http://localhost:8081/api/v1/project \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"e-commerce-platform","version":"2024"}' | jq -r '.uuid')

echo "Parent UUID: $PARENT_UUID"
```

### Upload child SBOM

```bash
./scripts/upload-sbom.sh \
  --file    payment-service/target/bom.json \
  --project payment-service \
  --version "2.3.1" \
  --parent  "$PARENT_UUID"
```

---

## 9. Tags and Properties

### Tags

Tags enable filtering and grouping in both the UI and API:

```bash
# Common tagging strategies:
--tags "java,spring-boot"              # technology stack
--tags "team-payments,pci-dss"         # ownership + compliance
--tags "release-2024-q1,microservice"  # release cycle + type
```

### Custom properties

```bash
# Set a custom property via API
curl -sf \
  -X PUT "http://localhost:8081/api/v1/project/${PROJECT_UUID}/property" \
  -H "X-Api-Key: $DT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"groupName":"custom","propertyName":"owner","propertyValue":"team-payments","propertyType":"STRING"}'
```

---

## 10. Understanding Analysis Results

After uploading an SBOM, DependencyTrack assigns each component a risk score
based on discovered vulnerabilities.

### Risk Severity Levels

| Level        | CVSS Score  | Action Required                                |
|--------------|-------------|------------------------------------------------|
| **Critical** | 9.0 – 10.0  | Immediate — patch within 24–72 hours           |
| **High**     | 7.0 – 8.9   | Urgent — patch within 7 days                  |
| **Medium**   | 4.0 – 6.9   | Planned — patch in next sprint/release         |
| **Low**      | 0.1 – 3.9   | Backlog — patch when convenient                |
| **OK**       | —           | No known vulnerabilities                       |

### Risk Categories in the Dashboard

| Category          | What it measures                                           |
|-------------------|------------------------------------------------------------|
| **Security**      | CVE/CVSS-rated vulnerabilities in components               |
| **Operational**   | Unreviewed, suppressed, and inherited risk items           |
| **License**       | Policy violations triggered by component licenses         |

### Drill down in the UI

1. Click a project name in the DependencyTrack UI
2. Navigate to **Components** to see each library
3. Click a component to see its CVE list and CVSS details
4. Click **Vulnerability** to view full CVE description, fix recommendations, and NVD links
