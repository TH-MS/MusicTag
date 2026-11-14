//! MusicTag core: reading and writing audio tags, cover art handling.

use base64::Engine;
use lofty::config::WriteOptions;
use lofty::prelude::*;
use lofty::picture::{Picture, PictureInformation, PictureType};
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "m4b", "mp4", "flac", "ogg", "oga", "opus", "wav", "aif", "aiff", "wv", "ape",
];

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct CoverInfo {
    pub width: u32,
    pub height: u32,
    pub bytes: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TrackInfo {
    pub path: String,
    pub filename: String,
    pub kind: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub genre: String,
    pub sort_album: String,
    pub comment: String,
    pub composer: String,
    pub year: String,
    pub track: String,
    pub track_total: String,
    pub disc: String,
    pub disc_total: String,
    pub bitrate: u32,
    pub duration: f64,
    pub size: u64,
    pub cover: Option<CoverInfo>,
}

#[derive(Deserialize, Debug)]
pub struct TrackEdit {
    pub path: String,
    /// Keys: title, artist, album, album_artist, genre, sort_album, comment,
    /// composer, year, track, track_total, disc, disc_total. Empty string removes the value.
    pub fields: HashMap<String, String>,
    /// Copy the front cover of this file into the edited file.
    pub cover_from: Option<String>,
    /// After tagging, move the file to `<root>/<parts[0]>/<parts[1]>/.../<last part>.<ext>`.
    pub dest_root: Option<String>,
    pub dest_parts: Option<Vec<String>>,
}

#[derive(Serialize, Debug)]
pub struct SaveResult {
    pub path: String,
    pub ok: bool,
    pub error: Option<String>,
    pub track: Option<TrackInfo>,
}

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn is_audio(p: &Path) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn collect(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_dir() {
        if let Ok(rd) = std::fs::read_dir(path) {
            let mut entries: Vec<PathBuf> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
            entries.sort();
            for e in entries {
                collect(&e, out);
            }
        }
    } else if is_audio(path) {
        out.push(path.to_path_buf());
    }
}

/// Expand files/folders (recursively) and read every supported audio file.
pub fn load_paths(paths: &[String]) -> Vec<TrackInfo> {
    let mut files = Vec::new();
    for p in paths {
        collect(Path::new(p), &mut files);
    }
    files.sort();
    files.dedup();
    files
        .par_iter()
        .filter_map(|f| read_track(f).ok())
        .collect()
}

fn pick_picture(tag: &Tag) -> Option<&Picture> {
    let pics = tag.pictures();
    pics.iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| pics.first())
}

fn cover_info(pic: &Picture) -> CoverInfo {
    let (width, height) = PictureInformation::from_picture(pic)
        .map(|i| (i.width, i.height))
        .unwrap_or((0, 0));
    CoverInfo { width, height, bytes: pic.data().len() }
}

pub fn read_track(path: &Path) -> Result<TrackInfo, String> {
    let tagged = Probe::open(path)
        .map_err(es)?
        .guess_file_type()
        .map_err(es)?
        .read()
        .map_err(es)?;
    let props = tagged.properties();
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());

    let s = |k: ItemKey| -> String {
        tag.and_then(|t| t.get_string(&k)).unwrap_or("").trim().to_string()
    };

    let mut track = s(ItemKey::TrackNumber);
    let mut track_total = s(ItemKey::TrackTotal);
    let mut disc = s(ItemKey::DiscNumber);
    let mut disc_total = s(ItemKey::DiscTotal);
    // Some formats keep "n/total" in one value.
    for (n, t) in [(&mut track, &mut track_total), (&mut disc, &mut disc_total)] {
        if let Some((a, b)) = n.clone().split_once('/') {
            *n = a.trim().to_string();
            if t.is_empty() {
                *t = b.trim().to_string();
            }
        }
    }

    let year = {
        let d = s(ItemKey::RecordingDate);
        if d.is_empty() { s(ItemKey::Year) } else { d }
    };

    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    Ok(TrackInfo {
        path: path.to_string_lossy().to_string(),
        filename: path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
        kind: ext,
        title: s(ItemKey::TrackTitle),
        artist: s(ItemKey::TrackArtist),
        album: s(ItemKey::AlbumTitle),
        album_artist: s(ItemKey::AlbumArtist),
        genre: s(ItemKey::Genre),
        sort_album: s(ItemKey::AlbumTitleSortOrder),
        comment: s(ItemKey::Comment),
        composer: s(ItemKey::Composer),
        year,
        track,
        track_total,
        disc,
        disc_total,
        bitrate: props.audio_bitrate().unwrap_or(0),
        duration: props.duration().as_secs_f64(),
        size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        cover: tag.and_then(pick_picture).map(cover_info),
    })
}

fn read_picture(path: &Path) -> Result<Option<Picture>, String> {
    let tagged = Probe::open(path)
        .map_err(es)?
        .guess_file_type()
        .map_err(es)?
        .read()
        .map_err(es)?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    Ok(tag.and_then(pick_picture).cloned())
}

/// Front cover of a file as a `data:` URL (for display).
pub fn cover_data_url(path: &str) -> Option<String> {
    let pic = read_picture(Path::new(path)).ok()??;
    let mime = pic
        .mime_type()
        .map(|m| m.to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Some(format!("data:{mime};base64,{b64}"))
}

fn set_text(tag: &mut Tag, key: ItemKey, value: &str) {
    let v = value.trim();
    tag.remove_key(&key);
    if !v.is_empty() {
        tag.insert_text(key, v.to_string());
    }
}

fn write_track(edit: &TrackEdit, covers: &HashMap<String, Option<Picture>>) -> Result<(), String> {
    let path = Path::new(&edit.path);
    let mut tagged = Probe::open(path)
        .map_err(es)?
        .guess_file_type()
        .map_err(es)?
        .read()
        .map_err(es)?;

    if tagged.primary_tag().is_none() {
        let tt = tagged.primary_tag_type();
        tagged.insert_tag(Tag::new(tt));
    }
    let tag = tagged.primary_tag_mut().ok_or("no writable tag")?;

    for (k, v) in &edit.fields {
        match k.as_str() {
            "title" => set_text(tag, ItemKey::TrackTitle, v),
            "artist" => set_text(tag, ItemKey::TrackArtist, v),
            "album" => set_text(tag, ItemKey::AlbumTitle, v),
            "album_artist" => set_text(tag, ItemKey::AlbumArtist, v),
            "genre" => set_text(tag, ItemKey::Genre, v),
            "sort_album" => set_text(tag, ItemKey::AlbumTitleSortOrder, v),
            "comment" => set_text(tag, ItemKey::Comment, v),
            "composer" => set_text(tag, ItemKey::Composer, v),
            "track" => set_text(tag, ItemKey::TrackNumber, v),
            "track_total" => set_text(tag, ItemKey::TrackTotal, v),
            "disc" => set_text(tag, ItemKey::DiscNumber, v),
            "disc_total" => set_text(tag, ItemKey::DiscTotal, v),
            "year" => {
                // ID3v2.4 has no TYER; RecordingDate (TDRC / DATE / ©day) holds year or full date.
                tag.remove_key(&ItemKey::Year);
                set_text(tag, ItemKey::RecordingDate, v);
            }
            _ => {}
        }
    }

    if let Some(src) = &edit.cover_from {
        if let Some(Some(pic)) = covers.get(src) {
            while !tag.pictures().is_empty() {
                tag.remove_picture(0);
            }
            let mut p = pic.clone();
            p.set_pic_type(PictureType::CoverFront);
            tag.push_picture(p);
        }
    }

    // ID3v2.4: v2.3 cannot hold Sort Album (TSOA) or full dates (TDRC), so keep the default.
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(es)
}

/// Make one path component safe on Windows (same spirit as MP3Tag: bad characters become `_`).
pub fn sanitize(part: &str) -> String {
    let cleaned: String = part
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if cleaned.is_empty() { "_".to_string() } else { cleaned }
}

fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// Move `from` to its destination; returns the final path. Never overwrites another file.
fn move_file(from: &Path, root: &str, parts: &[String]) -> Result<PathBuf, String> {
    if parts.is_empty() {
        return Ok(from.to_path_buf());
    }
    let ext = from.extension().and_then(|e| e.to_str()).unwrap_or("");
    let mut dir = PathBuf::from(root);
    for p in &parts[..parts.len() - 1] {
        dir.push(sanitize(p));
    }
    let stem = sanitize(&parts[parts.len() - 1]);
    let name = |n: u32| {
        let suffix = if n == 0 { String::new() } else { format!(" ({n})") };
        if ext.is_empty() { format!("{stem}{suffix}") } else { format!("{stem}{suffix}.{ext}") }
    };
    std::fs::create_dir_all(&dir).map_err(es)?;
    let mut n = 0;
    let target = loop {
        let t = dir.join(name(n));
        if norm(&t) == norm(from) {
            return Ok(from.to_path_buf()); // already in place
        }
        if !t.exists() {
            break t;
        }
        n += 1;
    };
    if std::fs::rename(from, &target).is_err() {
        // e.g. different drive: copy then remove
        std::fs::copy(from, &target).map_err(es)?;
        std::fs::remove_file(from).map_err(es)?;
    }
    Ok(target)
}

pub fn save_tracks(edits: Vec<TrackEdit>) -> Vec<SaveResult> {
    // Load every distinct cover source once, up-front (before any file is touched).
    let mut covers: HashMap<String, Option<Picture>> = HashMap::new();
    for e in &edits {
        if let Some(src) = &e.cover_from {
            covers
                .entry(src.clone())
                .or_insert_with(|| read_picture(Path::new(src)).ok().flatten());
        }
    }
    // Tags are written in parallel; moves afterwards, one at a time, so name clashes resolve cleanly.
    let written: Vec<Result<(), String>> = edits.par_iter().map(|e| write_track(e, &covers)).collect();
    edits
        .iter()
        .zip(written)
        .map(|(e, w)| {
            let fail = |err: String| SaveResult { path: e.path.clone(), ok: false, error: Some(err), track: None };
            if let Err(err) = w {
                return fail(err);
            }
            let mut final_path = PathBuf::from(&e.path);
            if let (Some(root), Some(parts)) = (&e.dest_root, &e.dest_parts) {
                match move_file(&final_path, root, parts) {
                    Ok(p) => final_path = p,
                    Err(err) => return fail(format!("tags saved, but could not move file: {err}")),
                }
            }
            match read_track(&final_path) {
                Ok(t) => SaveResult { path: e.path.clone(), ok: true, error: None, track: Some(t) },
                Err(err) => SaveResult { path: e.path.clone(), ok: true, error: Some(err), track: None },
            }
        })
        .collect()
}
