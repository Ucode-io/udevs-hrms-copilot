# Image targets called by Ucode-io/ci-cd (.github/workflows/build.yml).
#
# The workflow passes TAG, PROJECT_NAME, REGISTRY and ENV_TAG; APP is the
# repository's own directory name, which on the runner is the repository name —
# and that same name is what deploy.yml uses to find
# clusters/<cluster>/<namespace>/<name>/values.yaml in Ucode-io/deployments.
# Renaming the repository therefore renames the image and orphans the values
# file; do both together or neither.

CURRENT_DIR=$(shell pwd)
APP=$(shell basename ${CURRENT_DIR})

REGISTRY=ghcr.io
TAG=latest
ENV_TAG=latest
PROJECT_NAME=ucode-io
DOCKERFILE=Dockerfile

build-image:
	docker build --rm -t ${REGISTRY}/${PROJECT_NAME}/${APP}:${TAG} . -f ${DOCKERFILE}
	docker tag ${REGISTRY}/${PROJECT_NAME}/${APP}:${TAG} ${REGISTRY}/${PROJECT_NAME}/${APP}:${ENV_TAG}

push-image:
	docker push ${REGISTRY}/${PROJECT_NAME}/${APP}:${TAG}
	docker push ${REGISTRY}/${PROJECT_NAME}/${APP}:${ENV_TAG}

clear-image:
	docker rmi ${REGISTRY}/${PROJECT_NAME}/${APP}:${TAG}
	docker rmi ${REGISTRY}/${PROJECT_NAME}/${APP}:${ENV_TAG}

# ─── Local ──────────────────────────────────────────────────────────────────

install:
	npm ci

test:
	npx jest

build:
	npm run build

run: build
	node --env-file=.env dist/main.js
