use musictag_core::*;
use std::collections::HashMap;
use std::path::PathBuf;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("musictag-test-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d.join(name)
}

/// ~0.26s of valid, silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz).
fn silent_mp3() -> Vec<u8> {
    let mut v = Vec::new();
    for _ in 0..10 {
        v.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x64]);
        v.extend(std::iter::repeat(0u8).take(413));
    }
    v
}

/// PNG header with the given dimensions (enough for dimension sniffing).
fn fake_png(w: u32, h: u32) -> Vec<u8> {
    let mut v = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    v.extend_from_slice(&13u32.to_be_bytes());
    v.extend_from_slice(b"IHDR");
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v.extend_from_slice(&[8, 2, 0, 0, 0]);
    v.extend_from_slice(&[0, 0, 0, 0]); // crc (not checked)
    v.extend_from_slice(&0u32.to_be_bytes());
    v.extend_from_slice(b"IEND");
    v.extend_from_slice(&[0xAE, 0x42, 0x60, 0x82]);
    v
}

fn edit(path: &PathBuf, f: &[(&str, &str)], cover_from: Option<&PathBuf>) -> TrackEdit {
    TrackEdit {
        path: path.to_string_lossy().to_string(),
        fields: f.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<HashMap<_, _>>(),
        cover_from: cover_from.map(|p| p.to_string_lossy().to_string()),
        dest_root: None,
        dest_parts: None,
        cover_data: None,
        remove_cover: false,
    }
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

#[test]
fn text_fields_and_padding_roundtrip() {
    let p = tmp("a.mp3");
    std::fs::write(&p, silent_mp3()).unwrap();
    let r = save_tracks(vec![edit(
        &p,
        &[
            ("title", "Virginia Plain"),
            ("artist", "Roxy Music"),
            ("album", "Roxy Music"),
            ("album_artist", "Roxy Music"),
            ("genre", "Rock"),
            ("sort_album", "Roxy Music, The"),
            ("year", "1972"),
            ("track", "01"),
            ("track_total", "10"),
            ("disc", "01"),
            ("disc_total", "03"),
        ],
        None,
    )]);
    assert!(r[0].ok, "{:?}", r[0].error);
    let t = read_track(&p).unwrap();
    assert_eq!(t.title, "Virginia Plain");
    assert_eq!(t.album_artist, "Roxy Music");
    assert_eq!(t.sort_album, "Roxy Music, The");
    assert_eq!(t.year, "1972");
    assert_eq!(t.kind, "mp3");
    // Zero padding must survive on disk.
    assert_eq!(t.track, "01", "track: {:?}", t.track);
    assert_eq!(t.track_total, "10");
    assert_eq!(t.disc, "01", "disc: {:?}", t.disc);
    assert_eq!(t.disc_total, "03");
    let bytes = std::fs::read(&p).unwrap();
    assert!(contains(&bytes, b"01/10"), "TRCK not stored as 01/10");
    assert!(contains(&bytes, b"01/03"), "TPOS not stored as 01/03");
}

#[test]
fn full_date_year_and_clearing() {
    let p = tmp("b.mp3");
    std::fs::write(&p, silent_mp3()).unwrap();
    save_tracks(vec![edit(&p, &[("year", "1999-11-09"), ("genre", "Rock")], None)]);
    let t = read_track(&p).unwrap();
    assert!(t.year.starts_with("1999"), "year: {:?}", t.year);
    save_tracks(vec![edit(&p, &[("genre", "")], None)]);
    assert_eq!(read_track(&p).unwrap().genre, "");
}

#[test]
fn cover_copy_between_files() {
    use lofty::picture::{Picture, PictureType, MimeType};
    use lofty::prelude::*;
    use lofty::tag::Tag;
    use lofty::probe::Probe;

    let big = tmp("big.mp3");
    let small = tmp("small.mp3");
    std::fs::write(&big, silent_mp3()).unwrap();
    std::fs::write(&small, silent_mp3()).unwrap();
    for (p, w) in [(&big, 800u32), (&small, 300u32)] {
        let mut tf = Probe::open(p).unwrap().guess_file_type().unwrap().read().unwrap();
        let tt = tf.primary_tag_type();
        let mut tag = Tag::new(tt);
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Png),
            None,
            fake_png(w, w),
        ));
        tf.insert_tag(tag);
        tf.save_to_path(p, lofty::config::WriteOptions::default()).unwrap();
    }
    let c = read_track(&small).unwrap().cover.unwrap();
    assert_eq!((c.width, c.height), (300, 300));

    let r = save_tracks(vec![edit(&small, &[("title", "x")], Some(&big))]);
    assert!(r[0].ok, "{:?}", r[0].error);
    let c = read_track(&small).unwrap().cover.unwrap();
    assert_eq!((c.width, c.height), (800, 800));
    assert!(cover_data_url(&small.to_string_lossy()).unwrap().starts_with("data:image/png;base64,"));
}

#[test]
fn folders_are_scanned() {
    let d = tmp("folder");
    std::fs::create_dir_all(d.join("sub")).unwrap();
    std::fs::write(d.join("one.mp3"), silent_mp3()).unwrap();
    std::fs::write(d.join("sub").join("two.mp3"), silent_mp3()).unwrap();
    std::fs::write(d.join("notes.txt"), b"hi").unwrap();
    let t = load_paths(&[d.to_string_lossy().to_string()]);
    assert_eq!(t.len(), 2);
}

#[test]
fn moves_into_artist_album_folders() {
    let root = tmp("lib");
    let _ = std::fs::remove_dir_all(&root);
    let a = tmp("m1.mp3");
    let b = tmp("m2.mp3");
    std::fs::write(&a, silent_mp3()).unwrap();
    std::fs::write(&b, silent_mp3()).unwrap();
    let mk = |p: &PathBuf| {
        let mut e = edit(p, &[("title", "Song")], None);
        e.dest_root = Some(root.to_string_lossy().to_string());
        e.dest_parts = Some(vec!["AC/DC".into(), "Back in Black?".into(), "1-01 - Song".into()]);
        e
    };
    let r = save_tracks(vec![mk(&a), mk(&b)]);
    assert!(r.iter().all(|x| x.ok), "{:?}", r.iter().map(|x| &x.error).collect::<Vec<_>>());
    let p1 = r[0].track.as_ref().unwrap().path.clone();
    let p2 = r[1].track.as_ref().unwrap().path.clone();
    assert!(p1.replace('\\', "/").ends_with("AC_DC/Back in Black_/1-01 - Song.mp3"), "{p1}");
    assert!(p2.ends_with("1-01 - Song (1).mp3"), "{p2}");
    assert!(!a.exists() && !b.exists());
    // Saving again is a no-op move.
    let again = save_tracks(vec![TrackEdit {
        path: p1.clone(), fields: HashMap::new(), cover_from: None,
        dest_root: Some(root.to_string_lossy().to_string()),
        dest_parts: Some(vec!["AC/DC".into(), "Back in Black?".into(), "1-01 - Song".into()]),
        cover_data: None,
        remove_cover: false,
    }]);
    assert_eq!(again[0].track.as_ref().unwrap().path, p1);
}

fn id3v23(frames: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, payload) in frames {
        body.extend_from_slice(id.as_bytes());
        body.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        body.extend_from_slice(&[0, 0]);
        body.extend_from_slice(payload);
    }
    let sz = body.len();
    let mut v = b"ID3".to_vec();
    v.extend_from_slice(&[3, 0, 0]);
    v.extend_from_slice(&[((sz >> 21) & 0x7f) as u8, ((sz >> 14) & 0x7f) as u8, ((sz >> 7) & 0x7f) as u8, (sz & 0x7f) as u8]);
    v.extend(body);
    v
}
fn text(s: &str) -> Vec<u8> {
    let mut p = vec![0u8];
    p.extend_from_slice(s.as_bytes());
    p
}

/// A file tagged by an older tool: v2.3 year+date frames, an ID3v1 block, a rating and a PRIV frame.
fn legacy_file(name: &str) -> PathBuf {
    let p = tmp(name);
    let mut v = id3v23(&[
        ("TIT2", text("Old title")),
        ("TYER", text("1999")),
        ("TDAT", text("0105")),
        ("POPM", [b"me@x.org\0".as_slice(), &[200, 0, 0, 0, 3]].concat()),
        ("PRIV", [b"owner\0".as_slice(), b"secret-data"].concat()),
    ]);
    v.extend(silent_mp3());
    let mut v1 = vec![0u8; 128];
    v1[..3].copy_from_slice(b"TAG");
    v1[3..11].copy_from_slice(b"Old v1  ");
    v.extend(v1);
    std::fs::write(&p, v).unwrap();
    p
}

#[test]
fn year_is_exact_with_no_legacy_duplicates() {
    let p = legacy_file("legacy.mp3");
    let r = save_tracks(vec![edit(&p, &[("year", "1999")], None)]);
    assert!(r[0].ok, "{:?}", r[0].error);
    let b = std::fs::read(&p).unwrap();
    assert!(contains(&b, b"TDRC"), "no TDRC frame");
    assert!(!contains(&b, b"TYER"), "legacy TYER still present");
    assert!(!contains(&b, b"TDAT"), "legacy TDAT (day/month) still present");
    assert_eq!(read_track(&p).unwrap().year, "1999");
    let tail = &b[b.len() - 128..];
    assert_ne!(&tail[..3], b"TAG", "ID3v1 block still present");
}

#[test]
fn other_frames_survive_a_save() {
    let p = legacy_file("legacy2.mp3");
    save_tracks(vec![edit(&p, &[("title", "New")], None)]);
    let b = std::fs::read(&p).unwrap();
    assert!(contains(&b, b"POPM"), "rating frame lost");
    assert!(contains(&b, b"PRIV"), "PRIV frame lost");
}

#[test]
fn cover_from_data_url_and_removal() {
    use base64::Engine;
    let p = tmp("cd.mp3");
    std::fs::write(&p, silent_mp3()).unwrap();
    let url = format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(fake_png(640, 640)));
    let mut e = edit(&p, &[], None);
    e.cover_data = Some(url);
    assert!(save_tracks(vec![e])[0].ok);
    let c = read_track(&p).unwrap().cover.unwrap();
    assert_eq!((c.width, c.height), (640, 640));
    let mut e = edit(&p, &[], None);
    e.remove_cover = true;
    assert!(save_tracks(vec![e])[0].ok);
    assert!(read_track(&p).unwrap().cover.is_none());
}
