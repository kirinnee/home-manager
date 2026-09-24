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

# Trim: for every section listed in models.keep.json keep ONLY those ids, so the
# proxy (and therefore Claude Code's /model picker, which lists every id the
# gateway advertises) only shows the fleet's current models.
keep_file="${fork_dir}/models.keep.json"
if [[ -f ${keep_file} ]]; then
  jq --slurpfile keep "${keep_file}" '
    reduce ($keep[0] | to_entries[]) as $section (.;
      .[$section.key] = ((.[$section.key] // []) | map(select(.id as $id | $section.value | index($id))))
    )
  ' "${models_file}" >"${patched_models}"
  mv -- "${patched_models}" "${models_file}"
fi

patch_dir="${fork_dir}/patches"
shopt -s nullglob
patches=("${patch_dir}"/*.patch)
shopt -u nullglob
for patch_file in "${patches[@]}"; do
  echo "Applying $(basename -- "${patch_file}")..."
  git -C "${source_dir}" apply --check "${patch_file}"
  git -C "${source_dir}" apply "${patch_file}"
done

grep -q 'entry\["model_states"\]' "${source_dir}/internal/api/handlers/management/auth_files.go"

jq -e --slurpfile overlay "${overlay_file}" '
  # Every overlay entry must land verbatim (one copy each) in the patched catalog.
  . as $patched
  | all($overlay[0] | to_entries[];
      .key as $section | all(.value[]; . as $want
        | ([$patched[$section][] | select(.id == $want.id)] | length == 1)
          and (($patched[$section][] | select(.id == $want.id)) == $want)))
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
  --build-arg "VERSION=${UPSTREAM_REF}+kloge-opus55.trim1" \
  --build-arg "COMMIT=${UPSTREAM_COMMIT}" \
  --build-arg "BUILD_DATE=${UPSTREAM_RELEASE_DATE}" \
  --label "org.opencontainers.image.source=${UPSTREAM_REPOSITORY}" \
  --label "org.opencontainers.image.revision=${UPSTREAM_COMMIT}" \
  --label "io.kloge.model-catalog=$(jq -r '.claude | join(",")' "${keep_file}")" \
  --label "io.kloge.management-model-states=redacted-v1" \
  --tag "${image_tag}" \
  "${source_dir}"

echo "Built ${image_tag}"
