import { useEffect, useState } from "react";
import "./App.css";

const API_BASE = "http://localhost:3001";

export default function Videos() {
    const [videos, setVideos] = useState([]);
    const [selected, setSelected] = useState(null);

    useEffect(() => {
        fetch(`${API_BASE}/videos`)
            .then(r => r.json())
            .then(setVideos);
    }, []);

    return (
        <div className="app">
            <div className="list">
                <h2 className="recordings"></h2>
                {videos.map(v => (
                    <div className="video-item" key={v.id}
                        onClick={() => setSelected(v)}>
                        <div className="video-title"></div>
                        <div className="video-date">{new Date(v.createdAt).toLocaleString()}</div>
                    </div>
                ))}
            </div>

            <div className="preview">
                {selected ? (
                    <>
                        <div className="span">
                            <h2 className="video-title">{selected.title}</h2>
                            <button className="close-display" onClick={() => setSelected(null)}>X</button>
                        </div>
                        <video
                            controls
                            className="video"
                            src={`${API_BASE}/videos/${selected.id}/stream`}
                        />
                    </>
                ) : (
                    <div>select video</div>
                )}
            </div>
        </div>
    );
}