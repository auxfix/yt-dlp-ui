//! "Update engine": fetch the latest **nightly** yt-dlp release for the
//! running OS into app-data, which `engine::resolve_engine` then prefers.

use serde::Deserialize;

pub const NIGHTLY_LATEST_URL: &str =
    "https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest";

pub fn latest_url() -> &'static str {
    NIGHTLY_LATEST_URL
}

/// The release asset for a given target OS.
pub fn asset_name(os: &str) -> Option<&'static str> {
    match os {
        "linux" => Some("yt-dlp_linux"),
        "windows" => Some("yt-dlp.exe"),
        _ => None,
    }
}

#[derive(Debug, PartialEq, Deserialize)]
pub struct Asset {
    pub name: String,
    #[serde(rename = "browser_download_url")]
    pub url: String,
}

#[derive(Debug, PartialEq)]
pub struct PickedAsset {
    pub tag: String,
    pub url: String,
}

/// Pick the download URL for `os` out of a GitHub latest-release JSON.
pub fn pick_asset(json: &str, os: &str) -> Option<PickedAsset> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let tag = value.get("tag_name")?.as_str()?.to_string();
    let name = asset_name(os)?;
    let assets: Vec<Asset> = serde_json::from_value(value.get("assets")?.clone()).ok()?;
    assets
        .into_iter()
        .find(|a| a.name == name)
        .map(|a| PickedAsset { tag, url: a.url })
}

/// Download `url` into `dest` following redirects. Returns error text on
/// failure. Network side — no test double here.
pub fn download_to_file(url: &str, dest: &std::path::Path) -> Result<(), String> {
    let resp = reqwest::blocking::get(url)
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(dest, &bytes).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(dest)
            .map_err(|e| e.to_string())?
            .permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(dest, perms).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linux_asset_url() {
        assert_eq!(asset_name("linux"), Some("yt-dlp_linux"));
    }

    #[test]
    fn windows_asset_url() {
        assert_eq!(asset_name("windows"), Some("yt-dlp.exe"));
    }

    #[test]
    fn unknown_os_has_no_asset() {
        assert!(asset_name("templeos").is_none());
    }

    #[test]
    fn nightly_api_url() {
        assert_eq!(
            latest_url(),
            "https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest"
        );
    }

    const JSON_FIXTURE: &str = r#"{
      "tag_name": "2025.06.15.232803",
      "assets": [
        { "name": "yt-dlp", "browser_download_url": "https://example/yt-dlp" },
        { "name": "yt-dlp_linux", "browser_download_url": "https://example/yt-dlp_linux" },
        { "name": "yt-dlp.exe", "browser_download_url": "https://example/yt-dlp.exe" }
      ]
    }"#;

    #[test]
    fn parses_linux_download_url() {
        let pick = pick_asset(JSON_FIXTURE, "linux").unwrap();
        assert_eq!(pick.tag, "2025.06.15.232803");
        assert_eq!(pick.url, "https://example/yt-dlp_linux");
    }

    #[test]
    fn parses_windows_download_url() {
        let pick = pick_asset(JSON_FIXTURE, "windows").unwrap();
        assert_eq!(pick.url, "https://example/yt-dlp.exe");
    }

    #[test]
    fn missing_asset_is_none() {
        assert!(pick_asset(JSON_FIXTURE, "templeos").is_none());
        assert!(pick_asset("not json", "linux").is_none());
    }
}
