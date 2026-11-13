#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use musictag_core::{TrackEdit, TrackInfo, SaveResult};
use tauri::{DragDropEvent, Emitter, WindowEvent};

#[tauri::command]
async fn load_paths(paths: Vec<String>) -> Result<Vec<TrackInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || musictag_core::load_paths(&paths))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_tracks(edits: Vec<TrackEdit>) -> Result<Vec<SaveResult>, String> {
    tauri::async_runtime::spawn_blocking(move || musictag_core::save_tracks(edits))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_cover(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || musictag_core::cover_data_url(&path))
        .await
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![load_paths, save_tracks, get_cover])
        .on_window_event(|window, event| {
            if let WindowEvent::DragDrop(d) = event {
                match d {
                    DragDropEvent::Enter { .. } => {
                        let _ = window.emit("drag-state", true);
                    }
                    DragDropEvent::Leave => {
                        let _ = window.emit("drag-state", false);
                    }
                    DragDropEvent::Drop { paths, .. } => {
                        let _ = window.emit("drag-state", false);
                        let p: Vec<String> =
                            paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
                        let _ = window.emit("files-dropped", p);
                    }
                    _ => {}
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running MusicTag");
}
