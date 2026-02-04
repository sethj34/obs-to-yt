import { useEffect, useState } from "react";

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
        <>
            <div className="app">
                <div style={{ width: 360 }}>
                    <h2>Recordings</h2>
                    {videos.map(v => (
                        <div key={v.id} style={{ padding: 8, borderBottom: "1px solid #ddd", cursor: "pointer" }}
                            onClick={() => setSelected(v)}>
                            <div><b>{v.title}</b></div>
                            <div style={{ fontSize: 12, opacity: 0.7 }}>{new Date(v.createdAt).toLocaleString()}</div>
                        </div>
                    ))}
                </div>

                <div style={{ flex: 1 }}>
                    {selected ? (
                        <>
                            <h2>{selected.title}</h2>
                            <video
                                controls
                                style={{ width: "100%", maxHeight: "75vh" }}
                                src={`${API_BASE}/videos/${selected.id}/stream`}
                            />
                        </>
                    ) : (
                        <div>Select a video</div>
                    )}
                </div>
            </div>
        </>
    );
}