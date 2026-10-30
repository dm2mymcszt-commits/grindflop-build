#!/usr/bin/env sh
set -eu

OAUTH_URL_TYPE_NAME="dev.estopia.free-grind.google-oauth"
PROJECT_YML=""
INFO_PLIST=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-yml)
      [ "$#" -ge 2 ] || { echo "Missing path after --project-yml" >&2; exit 2; }
      PROJECT_YML="$2"
      shift 2
      ;;
    --info-plist)
      [ "$#" -ge 2 ] || { echo "Missing path after --info-plist" >&2; exit 2; }
      INFO_PLIST="$2"
      shift 2
      ;;
    *)
      echo "Unknown configure-ios-google-oauth option" >&2
      exit 2
      ;;
  esac
done

if [ -z "$PROJECT_YML" ] && [ -z "$INFO_PLIST" ]; then
  echo "Pass --project-yml and/or --info-plist" >&2
  exit 2
fi

configure_project_yml() {
  project_yml="$1"
  if [ ! -f "$project_yml" ]; then
    echo "Generated iOS project.yml was not found" >&2
    exit 1
  fi
  if grep -q '^[[:space:]]*- sdk: AuthenticationServices\.framework[[:space:]]*$' "$project_yml"; then
    return
  fi

  temporary_file="$(mktemp)"
  if ! awk '
    BEGIN { inserted = 0 }
    /^[[:space:]]*- sdk: Security\.framework[[:space:]]*$/ && inserted == 0 {
      print
      print "      - sdk: AuthenticationServices.framework"
      inserted = 1
      next
    }
    { print }
    END { if (inserted == 0) exit 3 }
  ' "$project_yml" > "$temporary_file"; then
    rm -f "$temporary_file"
    echo "Could not add AuthenticationServices.framework to the iOS project" >&2
    exit 1
  fi
  mv "$temporary_file" "$project_yml"
  echo "Configured the iOS authentication framework"
}

configure_info_plist() {
  info_plist="$1"
  if [ ! -f "$info_plist" ]; then
    echo "Generated iOS Info.plist was not found" >&2
    exit 1
  fi
  if [ ! -x /usr/libexec/PlistBuddy ]; then
    echo "PlistBuddy is required to configure the iOS OAuth callback" >&2
    exit 1
  fi

  client_id="${FREE_GRIND_GOOGLE_IOS_CLIENT_ID:-}"
  callback_scheme=""
  if [ -n "$client_id" ]; then
    suffix=".apps.googleusercontent.com"
    case "$client_id" in
      *[!a-z0-9.-]*|"$suffix")
        echo "FREE_GRIND_GOOGLE_IOS_CLIENT_ID is invalid" >&2
        exit 1
        ;;
      *"$suffix") ;;
      *)
        echo "FREE_GRIND_GOOGLE_IOS_CLIENT_ID is invalid" >&2
        exit 1
        ;;
    esac
    client_name="${client_id%"$suffix"}"
    case "$client_name" in
      ""|*[!a-z0-9-]*)
        echo "FREE_GRIND_GOOGLE_IOS_CLIENT_ID is invalid" >&2
        exit 1
        ;;
    esac
    if [ "${#client_name}" -gt 384 ]; then
      echo "FREE_GRIND_GOOGLE_IOS_CLIENT_ID is invalid" >&2
      exit 1
    fi
    callback_scheme="com.googleusercontent.apps.$client_name"
  fi

  index=0
  while /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:$index" "$info_plist" >/dev/null 2>&1; do
    entry_name="$(/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:$index:CFBundleURLName" "$info_plist" 2>/dev/null || true)"
    if [ "$entry_name" = "$OAUTH_URL_TYPE_NAME" ]; then
      /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes:$index" "$info_plist"
    else
      index=$((index + 1))
    fi
  done

  if [ -z "$callback_scheme" ]; then
    if ! /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:0" "$info_plist" >/dev/null 2>&1; then
      /usr/libexec/PlistBuddy -c "Delete :CFBundleURLTypes" "$info_plist" >/dev/null 2>&1 || true
    fi
    plutil -lint "$info_plist" >/dev/null
    echo "Removed any stale iOS Google OAuth callback entry"
    return
  fi

  /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$info_plist" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$info_plist"

  index=0
  while /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes:$index" "$info_plist" >/dev/null 2>&1; do
    index=$((index + 1))
  done
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:$index dict" "$info_plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:$index:CFBundleTypeRole string Editor" "$info_plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:$index:CFBundleURLName string $OAUTH_URL_TYPE_NAME" "$info_plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:$index:CFBundleURLSchemes array" "$info_plist"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:$index:CFBundleURLSchemes:0 string $callback_scheme" "$info_plist"
  plutil -lint "$info_plist" >/dev/null
  echo "Configured the iOS Google OAuth callback"
}

if [ -n "$PROJECT_YML" ]; then
  configure_project_yml "$PROJECT_YML"
fi
if [ -n "$INFO_PLIST" ]; then
  configure_info_plist "$INFO_PLIST"
fi
