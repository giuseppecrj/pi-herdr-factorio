valid_lane_id() {
  case "$1" in
    ""|*[!A-Za-z0-9_-]*) return 1 ;;
  esac
}

require_lane_ids() {
  local id
  for id in "$@"; do
    valid_lane_id "$id" || { printf 'refusing invalid lane id: %q\n' "$id" >&2; return 2; }
  done
}
