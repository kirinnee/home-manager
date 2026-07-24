#!/usr/bin/env bash
set -euo pipefail

fork_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${fork_dir}/upstream.env"

image_tag="${KLOGE_PATCHED_IMAGE:-kloge-cliproxy:patched}"
temp_parent="${TMPDIR:-/tmp}"
temp_parent="${temp_parent%/}"
[[ -n ${temp_parent} ]] || temp_parent="/"
temp_prefix="${temp_parent%/}/kloge-cliproxy."
build_root="$(mktemp -d "${temp_prefix}XXXXXXXX")"
source_dir="${build_root}/CLIProxyAPI"

cleanup() {
  case "${build_root:-}" in
  "${temp_prefix}"*) rm -rf -- "${build_root}" ;;
  esac
}
trap cleanup EXIT

echo "Cloning CLIProxyAPI ${UPSTREAM_REF} (${UPSTREAM_COMMIT})..."
git clone --quiet --depth 1 --branch "${UPSTREAM_REF}" --single-branch "${UPSTREAM_REPOSITORY}" "${source_dir}"

actual_commit="$(git -C "${source_dir}" rev-parse HEAD)"
if [[ ${actual_commit} != "${UPSTREAM_COMMIT}" ]]; then
  echo "Pinned ref mismatch: expected ${UPSTREAM_COMMIT}, got ${actual_commit}" >&2
  exit 1
fi

models_file="${source_dir}/internal/registry/models/models.json"
overlay_file="${fork_dir}/models.overlay.json"
patched_models="${models_file}.patched"

jq -e '
  type == "object"
  and all(to_entries[];
    (.value | type) == "array"
    and all(.value[]; (.id | type) == "string" and (.id | length) > 0)
  )
' "${overlay_file}" >/dev/null

jq --slurpfile overlay "${overlay_file}" '
  def upsert_by_id($additions):
    reduce $additions[] as $addition (.;
      if any(.[]; .id == $addition.id)
      then map(if .id == $addition.id then $addition else . end)
      else . + [$addition]
      end
    );
  reduce ($overlay[0] | to_entries[]) as $section (.;
    .[$section.key] = ((.[$section.key] // []) | upsert_by_id($section.value))
  )
' "${models_file}" >"${patched_models}"
mv -- "${patched_models}" "${models_file}"

jq -e '
  [.claude[] | select(.id == "claude-opus-5")] as $models
  | ($models | length) == 1
    and ($models[0].object == "model")
    and ($models[0].created == 1784038800)
    and ($models[0].owned_by == "anthropic")
    and ($models[0].type == "claude")
    and ($models[0].display_name == "Claude Opus 5")
    and ($models[0].description == "Premium model combining maximum intelligence with practical performance")
    and ($models[0].context_length == 1000000)
    and ($models[0].max_completion_tokens == 128000)
    and ($models[0].thinking.min == 1024)
    and ($models[0].thinking.max == 128000)
    and ($models[0].thinking.zero_allowed == true)
    and ($models[0].thinking.levels == ["low", "medium", "high", "xhigh", "max"])
' "${models_file}" >/dev/null
jq -e '
  all(to_entries[];
    (.value | type) == "array"
    and all(.value[]; (.id | type) == "string" and (.id | length) > 0)
    and ((.value | map(.id) | length) == (.value | map(.id) | unique | length))
  )
' "${models_file}" >/dev/null
git -C "${source_dir}" diff --check

echo "Building ${image_tag} from patched ${UPSTREAM_REF}..."
docker build \
  --build-arg "VERSION=${UPSTREAM_REF}+kloge-opus5" \
  --build-arg "COMMIT=${UPSTREAM_COMMIT}" \
  --build-arg "BUILD_DATE=${UPSTREAM_RELEASE_DATE}" \
  --label "org.opencontainers.image.source=${UPSTREAM_REPOSITORY}" \
  --label "org.opencontainers.image.revision=${UPSTREAM_COMMIT}" \
  --label "io.kloge.model-catalog=claude-opus-5" \
  --tag "${image_tag}" \
  "${source_dir}"

echo "Built ${image_tag}"
