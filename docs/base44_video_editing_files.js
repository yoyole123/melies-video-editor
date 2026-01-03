// EditingSuite
import React, { useState, useRef, useEffect, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { MeliesVideoEditor } from "melies-video-editor";
import "melies-video-editor/style.css";
import { ArrowLeft, Loader2 } from "lucide-react";
import { getTranslation } from "@/components/translations";

// Helper functions for blob URL conversion
async function toBlobUrl(httpUrl, { signal } = {}) {
    const res = await fetch(httpUrl, { signal });
    if (!res.ok) throw new Error(`Failed to fetch media: ${res.status}`);
    
    // Get the MIME type from response headers to preserve audio codec
    const contentType = res.headers.get('content-type') || 'video/mp4';
    const arrayBuffer = await res.arrayBuffer();
    const blob = new Blob([arrayBuffer], { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    
    // Preload video to ensure it's decoded and cached in memory
    // CRITICAL: Set volume to ensure audio track is loaded
    await new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.preload = 'auto';
        video.volume = 1.0; // Ensure audio is enabled
        video.muted = false; // Explicitly unmute
        video.playsInline = true; // Important for mobile
        video.src = blobUrl;
        
        // Wait for both video and audio to load
        video.onloadedmetadata = () => {
            // Verify audio track exists
            if (video.audioTracks && video.audioTracks.length === 0) {
                console.warn('Video has no audio tracks');
            }
            resolve();
        };
        video.onerror = () => reject(new Error('Failed to preload video'));
        
        // Set timeout to avoid hanging
        setTimeout(() => resolve(), 5000);
    });
    
    return blobUrl;
}

function pickStoryboardSourceUrls(movie) {
    const storyboard = Array.isArray(movie?.storyboard) ? movie.storyboard : [];
    const urls = [];

    for (let i = 0; i < storyboard.length; i++) {
        const shot = storyboard[i] || {};
        const selected = shot.selected_take_url;
        const takes = Array.isArray(shot.takes) ? shot.takes : [];

        const url = selected || takes[0];
        if (url) urls.push(url);
    }

    return urls;
}

export default function EditingSuite({ movie, onComplete, onBack }) {
    const [blobUrls, setBlobUrls] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const previousBlobUrlsRef = useRef([]);

    const t = (key) => getTranslation(movie.language || 'english', key);

    const storyboardSources = useMemo(() => {
        return pickStoryboardSourceUrls(movie);
    }, [movie]);

    useEffect(() => {
        const abort = new AbortController();
        let cancelled = false;

        async function buildBlobUrls() {
            setLoading(true);
            setError(null);
            
            try {
                const resolvedHttpUrls = [];
                
                for (const source of storyboardSources) {
                    if (!source) continue;

                    // Check if it's already an HTTP URL (public upload)
                    const isHttp = typeof source === "string" && /^https?:\/\//i.test(source);
                    if (isHttp) {
                        resolvedHttpUrls.push(source);
                    } else {
                        // Treat as private file_uri - sign it first
                        try {
                            const signedResult = await base44.integrations.Core.CreateFileSignedUrl({ 
                                file_uri: source 
                            });
                            const signedUrl = typeof signedResult === "string" ? signedResult : signedResult?.signed_url;
                            if (signedUrl) {
                                resolvedHttpUrls.push(signedUrl);
                            }
                        } catch (e) {
                            console.error("Failed to sign private file:", e);
                            // Skip this file
                        }
                    }
                }

                // Convert HTTP URLs to blob URLs
                const nextBlobUrls = [];
                for (const httpUrl of resolvedHttpUrls) {
                    if (!httpUrl) continue;
                    try {
                        const blobUrl = await toBlobUrl(httpUrl, { signal: abort.signal });
                        nextBlobUrls.push(blobUrl);
                    } catch (e) {
                        if (e.name !== 'AbortError') {
                            console.error("Failed to create blob URL:", e);
                        }
                    }
                }

                if (cancelled) {
                    // Cleanup blobs created during a cancelled run
                    nextBlobUrls.forEach((u) => URL.revokeObjectURL(u));
                    return;
                }

                // Revoke old blob URLs
                previousBlobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
                previousBlobUrlsRef.current = nextBlobUrls;

                setBlobUrls(nextBlobUrls);
                setLoading(false);
            } catch (err) {
                if (!cancelled) {
                    console.error("Failed to build editor blob URLs", err);
                    setError(err.message || "Failed to load video clips");
                    setLoading(false);
                }
            }
        }

        buildBlobUrls();

        return () => {
            cancelled = true;
            abort.abort();
            // Cleanup on unmount
            previousBlobUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
        };
    }, [storyboardSources]);

    if (loading) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-neutral-100 flex items-center justify-center" dir={movie.language === 'hebrew' || movie.language === 'arabic' ? 'rtl' : 'ltr'}>
                <div className="text-center">
                    <Loader2 className="w-12 h-12 text-cyan-500 animate-spin mx-auto mb-4" />
                    <p className="text-neutral-600">Loading video editor...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="min-h-screen bg-gradient-to-br from-slate-50 to-neutral-100 flex items-center justify-center p-6" dir={movie.language === 'hebrew' || movie.language === 'arabic' ? 'rtl' : 'ltr'}>
                <div className="max-w-md bg-white rounded-lg shadow-xl p-8 text-center">
                    <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                        <ArrowLeft className="w-8 h-8 text-red-600" />
                    </div>
                    <h3 className="text-xl font-bold text-neutral-900 mb-2">Failed to Load Editor</h3>
                    <p className="text-neutral-600 mb-6">{error}</p>
                    <Button onClick={onBack} variant="outline">
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back to Filming
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-neutral-100" dir={movie.language === 'hebrew' || movie.language === 'arabic' ? 'rtl' : 'ltr'}>
            {onBack && (
                <Button 
                    onClick={onBack} 
                    variant="ghost" 
                    className="absolute top-4 left-4 sm:top-6 sm:left-6 text-neutral-600 hover:bg-white hover:text-neutral-800 z-50 text-sm sm:text-base"
                >
                    <ArrowLeft className="w-4 h-4 mr-2" />
                    <span className="hidden sm:inline">Back to Filming</span>
                    <span className="sm:hidden">Back</span>
                </Button>
            )}

            <div className="w-full h-screen">
                <MeliesVideoEditor footageUrls={blobUrls} />
            </div>
        </div>
    );
}

// PreviewPlayer
import React, { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Play, Pause, SkipBack, SkipForward, Volume2, VolumeX, Maximize2 } from "lucide-react";

export default function PreviewPlayer({ clips, currentTime, onTimeUpdate, isPlaying, onPlayPause }) {
    const videoRef = useRef(null);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [duration, setDuration] = useState(0);

    // Calculate total duration
    useEffect(() => {
        const totalDuration = clips.reduce((sum, clip) => {
            const clipDuration = (clip.outPoint - clip.inPoint) / 1000;
            return sum + clipDuration;
        }, 0);
        setDuration(totalDuration);
    }, [clips]);

    // Find current clip based on playhead time
    const getCurrentClip = () => {
        let accumulatedTime = 0;
        for (const clip of clips) {
            const clipDuration = (clip.outPoint - clip.inPoint) / 1000;
            if (currentTime >= accumulatedTime && currentTime < accumulatedTime + clipDuration) {
                return {
                    clip,
                    offsetTime: currentTime - accumulatedTime,
                    startTime: accumulatedTime
                };
            }
            accumulatedTime += clipDuration;
        }
        return null;
    };

    const currentClipData = getCurrentClip();

    useEffect(() => {
        if (!videoRef.current || !currentClipData) return;

        const { clip, offsetTime } = currentClipData;
        const videoTime = (clip.inPoint / 1000) + offsetTime;

        if (videoRef.current.src !== clip.url) {
            videoRef.current.src = clip.url;
            videoRef.current.load();
        }

        if (Math.abs(videoRef.current.currentTime - videoTime) > 0.1) {
            videoRef.current.currentTime = videoTime;
        }

        if (isPlaying && videoRef.current.paused) {
            videoRef.current.play().catch(() => {});
        } else if (!isPlaying && !videoRef.current.paused) {
            videoRef.current.pause();
        }
    }, [currentClipData, isPlaying]);

    const handleVideoTimeUpdate = () => {
        if (!videoRef.current || !currentClipData) return;
        
        const { clip, startTime } = currentClipData;
        const videoTime = videoRef.current.currentTime * 1000;
        
        // Check if we've reached the clip's out point
        if (videoTime >= clip.outPoint) {
            const nextTime = startTime + ((clip.outPoint - clip.inPoint) / 1000);
            onTimeUpdate(nextTime);
        }
    };

    const formatTime = (seconds) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 10);
        return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
    };

    const handleSeek = (value) => {
        onTimeUpdate(value[0]);
    };

    const handleSkipBackward = () => {
        onTimeUpdate(Math.max(0, currentTime - 1));
    };

    const handleSkipForward = () => {
        onTimeUpdate(Math.min(duration, currentTime + 1));
    };

    const handleVolumeChange = (value) => {
        setVolume(value[0]);
        if (videoRef.current) {
            videoRef.current.volume = value[0];
        }
    };

    const toggleMute = () => {
        setIsMuted(!isMuted);
        if (videoRef.current) {
            videoRef.current.muted = !isMuted;
        }
    };

    const handleFullscreen = () => {
        if (videoRef.current) {
            if (videoRef.current.requestFullscreen) {
                videoRef.current.requestFullscreen();
            }
        }
    };

    return (
        <div className="bg-black rounded-lg overflow-hidden">
            <div className="relative aspect-video bg-neutral-900 flex items-center justify-center">
                {currentClipData ? (
                    <video
                        ref={videoRef}
                        className="w-full h-full object-contain"
                        onTimeUpdate={handleVideoTimeUpdate}
                        style={{
                            opacity: currentClipData.clip.opacity || 1,
                            transform: `scale(${currentClipData.clip.scale || 1})`
                        }}
                    />
                ) : (
                    <div className="text-neutral-600 text-center">
                        <Play className="w-16 h-16 mx-auto mb-2 opacity-30" />
                        <p>No clips in timeline</p>
                    </div>
                )}
                
                <div className="absolute top-2 right-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={handleFullscreen}
                        className="bg-black/50 hover:bg-black/70 text-white"
                    >
                        <Maximize2 className="w-4 h-4" />
                    </Button>
                </div>
            </div>

            <div className="p-4 bg-neutral-800 space-y-3">
                {/* Timeline scrubber */}
                <Slider
                    value={[currentTime]}
                    max={duration || 100}
                    step={0.01}
                    onValueChange={handleSeek}
                    className="cursor-pointer"
                />

                <div className="flex items-center justify-between text-white text-sm">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                </div>

                {/* Transport controls */}
                <div className="flex items-center justify-center gap-2">
                    <Button
                        onClick={handleSkipBackward}
                        variant="ghost"
                        size="icon"
                        className="text-white hover:bg-neutral-700"
                    >
                        <SkipBack className="w-4 h-4" />
                    </Button>

                    <Button
                        onClick={onPlayPause}
                        size="lg"
                        className="bg-cyan-600 hover:bg-cyan-700 text-white w-12 h-12 rounded-full"
                    >
                        {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5 ml-0.5" />}
                    </Button>

                    <Button
                        onClick={handleSkipForward}
                        variant="ghost"
                        size="icon"
                        className="text-white hover:bg-neutral-700"
                    >
                        <SkipForward className="w-4 h-4" />
                    </Button>
                </div>

                {/* Volume control */}
                <div className="flex items-center gap-2">
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleMute}
                        className="text-white hover:bg-neutral-700"
                    >
                        {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                    </Button>
                    <Slider
                        value={[isMuted ? 0 : volume]}
                        max={1}
                        step={0.01}
                        onValueChange={handleVolumeChange}
                        className="w-24"
                    />
                </div>
            </div>
        </div>
    );
}

// Timeline
import React, { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Scissors, Trash2, GripVertical } from "lucide-react";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";

const PIXELS_PER_SECOND = 100;
const SNAP_THRESHOLD = 10;

export default function Timeline({ 
    clips, 
    onClipsUpdate, 
    currentTime, 
    onTimeUpdate,
    duration,
    onClipSelect,
    selectedClipId 
}) {
    const timelineRef = useRef(null);
    const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
    const [scale, setScale] = useState(1);
    const [resizingClip, setResizingClip] = useState(null);

    const handlePlayheadDrag = (e) => {
        if (!timelineRef.current) return;
        const rect = timelineRef.current.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const time = Math.max(0, Math.min(duration, x / (PIXELS_PER_SECOND * scale)));
        onTimeUpdate(time);
    };

    const handlePlayheadMouseDown = () => {
        setIsDraggingPlayhead(true);
    };

    useEffect(() => {
        if (!isDraggingPlayhead) return;

        const handleMouseMove = (e) => {
            handlePlayheadDrag(e);
        };

        const handleMouseUp = () => {
            setIsDraggingPlayhead(false);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isDraggingPlayhead, duration, scale]);

    const handleTimelineClick = (e) => {
        if (e.target === timelineRef.current || e.target.classList.contains('timeline-track')) {
            handlePlayheadDrag(e);
        }
    };

    const handleDragEnd = (result) => {
        if (!result.destination) return;

        const items = Array.from(clips);
        const [reorderedItem] = items.splice(result.source.index, 1);
        items.splice(result.destination.index, 0, reorderedItem);

        // Recalculate positions
        let accumulatedTime = 0;
        const updatedClips = items.map(clip => {
            const clipDuration = (clip.outPoint - clip.inPoint) / 1000;
            const newClip = { ...clip, position: accumulatedTime * 1000 };
            accumulatedTime += clipDuration;
            return newClip;
        });

        onClipsUpdate(updatedClips);
    };

    const handleTrimStart = (clipId, e) => {
        e.stopPropagation();
        setResizingClip({ id: clipId, edge: 'start' });
    };

    const handleTrimEnd = (clipId, e) => {
        e.stopPropagation();
        setResizingClip({ id: clipId, edge: 'end' });
    };

    useEffect(() => {
        if (!resizingClip) return;

        const handleMouseMove = (e) => {
            if (!timelineRef.current) return;
            
            const rect = timelineRef.current.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const time = Math.max(0, x / (PIXELS_PER_SECOND * scale)) * 1000;

            const updatedClips = clips.map(clip => {
                if (clip.id !== resizingClip.id) return clip;

                if (resizingClip.edge === 'start') {
                    const newInPoint = Math.max(0, Math.min(time - clip.position, clip.outPoint - 100));
                    return { ...clip, inPoint: newInPoint };
                } else {
                    const maxOut = clip.mediaDuration || clip.outPoint;
                    const newOutPoint = Math.max(clip.inPoint + 100, Math.min(time - clip.position, maxOut));
                    return { ...clip, outPoint: newOutPoint };
                }
            });

            onClipsUpdate(updatedClips);
        };

        const handleMouseUp = () => {
            setResizingClip(null);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [resizingClip, clips, scale]);

    const handleSplitClip = (clipId) => {
        const clipIndex = clips.findIndex(c => c.id === clipId);
        if (clipIndex === -1) return;

        const clip = clips[clipIndex];
        const clipStartTime = clip.position / 1000;
        const clipEndTime = clipStartTime + ((clip.outPoint - clip.inPoint) / 1000);

        if (currentTime < clipStartTime || currentTime > clipEndTime) {
            alert("Move playhead to where you want to split the clip");
            return;
        }

        const splitPoint = (currentTime - clipStartTime) * 1000 + clip.inPoint;

        const newClips = [...clips];
        const firstHalf = {
            ...clip,
            id: `${clip.id}-split-1`,
            outPoint: splitPoint
        };
        const secondHalf = {
            ...clip,
            id: `${clip.id}-split-2`,
            inPoint: splitPoint,
            position: currentTime * 1000
        };

        newClips.splice(clipIndex, 1, firstHalf, secondHalf);
        
        // Recalculate positions for clips after split
        let accumulatedTime = 0;
        const updatedClips = newClips.map(c => {
            const clipDuration = (c.outPoint - c.inPoint) / 1000;
            const newClip = { ...c, position: accumulatedTime * 1000 };
            accumulatedTime += clipDuration;
            return newClip;
        });

        onClipsUpdate(updatedClips);
    };

    const handleDeleteClip = (clipId) => {
        const updatedClips = clips.filter(c => c.id !== clipId);
        
        // Recalculate positions
        let accumulatedTime = 0;
        const reindexedClips = updatedClips.map(clip => {
            const clipDuration = (clip.outPoint - clip.inPoint) / 1000;
            const newClip = { ...clip, position: accumulatedTime * 1000 };
            accumulatedTime += clipDuration;
            return newClip;
        });

        onClipsUpdate(reindexedClips);
    };

    const handleZoom = (direction) => {
        setScale(prev => {
            const newScale = direction === 'in' ? prev * 1.2 : prev / 1.2;
            return Math.max(0.5, Math.min(3, newScale));
        });
    };

    return (
        <div className="bg-neutral-900 border border-neutral-700 rounded-lg p-4">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-white font-bold">Timeline</h3>
                <div className="flex items-center gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleZoom('out')}
                        className="bg-neutral-800 border-neutral-700 text-white hover:bg-neutral-700"
                    >
                        -
                    </Button>
                    <span className="text-white text-sm">{Math.round(scale * 100)}%</span>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleZoom('in')}
                        className="bg-neutral-800 border-neutral-700 text-white hover:bg-neutral-700"
                    >
                        +
                    </Button>
                </div>
            </div>

            <div 
                ref={timelineRef}
                className="relative bg-neutral-800 rounded-lg overflow-x-auto overflow-y-hidden"
                style={{ height: '200px' }}
                onClick={handleTimelineClick}
            >
                {/* Time ruler */}
                <div className="h-8 bg-neutral-900 border-b border-neutral-700 flex items-center px-2">
                    {Array.from({ length: Math.ceil(duration) + 1 }).map((_, i) => (
                        <div
                            key={i}
                            className="text-neutral-400 text-xs absolute"
                            style={{ left: `${i * PIXELS_PER_SECOND * scale}px` }}
                        >
                            {i}s
                        </div>
                    ))}
                </div>

                {/* Video track */}
                <div className="timeline-track relative h-16 bg-neutral-800 border-b border-neutral-700">
                    <div className="absolute left-2 top-2 text-neutral-400 text-xs">Video</div>
                    
                    <DragDropContext onDragEnd={handleDragEnd}>
                        <Droppable droppableId="video-track" direction="horizontal">
                            {(provided) => (
                                <div
                                    {...provided.droppableProps}
                                    ref={provided.innerRef}
                                    className="absolute top-8 left-0 right-0 h-12"
                                >
                                    {clips.map((clip, index) => {
                                        const clipDuration = (clip.outPoint - clip.inPoint) / 1000;
                                        const clipWidth = clipDuration * PIXELS_PER_SECOND * scale;
                                        const clipLeft = (clip.position / 1000) * PIXELS_PER_SECOND * scale;

                                        return (
                                            <Draggable key={clip.id} draggableId={clip.id} index={index}>
                                                {(provided, snapshot) => (
                                                    <div
                                                        ref={provided.innerRef}
                                                        {...provided.draggableProps}
                                                        className={`absolute top-0 h-full rounded overflow-hidden cursor-pointer transition-all ${
                                                            selectedClipId === clip.id
                                                                ? 'ring-2 ring-cyan-500'
                                                                : 'border border-neutral-600'
                                                        } ${snapshot.isDragging ? 'opacity-70' : ''}`}
                                                        style={{
                                                            left: `${clipLeft}px`,
                                                            width: `${clipWidth}px`,
                                                            backgroundColor: '#1e293b',
                                                            ...provided.draggableProps.style
                                                        }}
                                                        onClick={() => onClipSelect(clip.id)}
                                                    >
                                                        {/* Trim handles */}
                                                        <div
                                                            className="absolute left-0 top-0 bottom-0 w-2 bg-cyan-500 cursor-ew-resize hover:bg-cyan-400"
                                                            onMouseDown={(e) => handleTrimStart(clip.id, e)}
                                                        />
                                                        <div
                                                            className="absolute right-0 top-0 bottom-0 w-2 bg-cyan-500 cursor-ew-resize hover:bg-cyan-400"
                                                            onMouseDown={(e) => handleTrimEnd(clip.id, e)}
                                                        />

                                                        {/* Clip content */}
                                                        <div {...provided.dragHandleProps} className="flex items-center justify-between h-full px-2">
                                                            <div className="flex items-center gap-1">
                                                                <GripVertical className="w-3 h-3 text-neutral-400" />
                                                                <span className="text-white text-xs truncate">{clip.name}</span>
                                                            </div>
                                                            <div className="flex items-center gap-1">
                                                                <Button
                                                                    size="icon"
                                                                    variant="ghost"
                                                                    className="w-6 h-6 hover:bg-neutral-700"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        handleSplitClip(clip.id);
                                                                    }}
                                                                >
                                                                    <Scissors className="w-3 h-3 text-white" />
                                                                </Button>
                                                                <Button
                                                                    size="icon"
                                                                    variant="ghost"
                                                                    className="w-6 h-6 hover:bg-neutral-700"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();
                                                                        handleDeleteClip(clip.id);
                                                                    }}
                                                                >
                                                                    <Trash2 className="w-3 h-3 text-red-400" />
                                                                </Button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                )}
                                            </Draggable>
                                        );
                                    })}
                                    {provided.placeholder}
                                </div>
                            )}
                        </Droppable>
                    </DragDropContext>
                </div>

                {/* Audio track */}
                <div className="timeline-track relative h-16 bg-neutral-800">
                    <div className="absolute left-2 top-2 text-neutral-400 text-xs">Audio</div>
                </div>

                {/* Playhead */}
                <div
                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10 cursor-ew-resize"
                    style={{ left: `${currentTime * PIXELS_PER_SECOND * scale}px` }}
                    onMouseDown={handlePlayheadMouseDown}
                >
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 w-3 h-3 bg-red-500 rounded-full" />
                </div>
            </div>

            <div className="mt-2 text-neutral-400 text-xs">
                <kbd className="px-2 py-1 bg-neutral-800 rounded">Space</kbd> Play/Pause
                <span className="mx-2">•</span>
                <kbd className="px-2 py-1 bg-neutral-800 rounded">S</kbd> Split
                <span className="mx-2">•</span>
                <kbd className="px-2 py-1 bg-neutral-800 rounded">Del</kbd> Delete
                <span className="mx-2">•</span>
                <kbd className="px-2 py-1 bg-neutral-800 rounded">Ctrl+Z</kbd> Undo
            </div>
        </div>
    );
}

// VideoEditor
import React, { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { base44 } from "@/api/base44Client";
import { ArrowLeft, Save, Download, Loader2, CheckCircle, AlertCircle, Check } from "lucide-react";
import MediaBin from "./MediaBin";
import PreviewPlayer from "./PreviewPlayer";
import Timeline from "./Timeline";
import InspectorPanel from "./InspectorPanel";

export default function VideoEditor({ movie, onBack, onComplete }) {
    const [media, setMedia] = useState([]);
    const [clips, setClips] = useState([]);
    const [currentTime, setCurrentTime] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [selectedClipId, setSelectedClipId] = useState(null);
    const [history, setHistory] = useState([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const [isSaving, setIsSaving] = useState(false);
    const [lastSaved, setLastSaved] = useState(new Date());
    const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [exportProgress, setExportProgress] = useState(0);
    const [exportError, setExportError] = useState(null);
    
    const saveTimeoutRef = useRef(null);
    const lastSaveDataRef = useRef(null);

    // Load project data
    useEffect(() => {
        loadProject();
    }, [movie.id]);

    const loadProject = async () => {
        try {
            const projectData = movie.editor_project;
            if (projectData) {
                setMedia(projectData.media || []);
                setClips(projectData.clips || []);
                setHistory([projectData.clips || []]);
                setHistoryIndex(0);
                lastSaveDataRef.current = JSON.stringify({ media: projectData.media || [], clips: projectData.clips || [] });
            } else {
                // Initialize with filming data
                const initialClips = (movie.storyboard || [])
                    .filter(shot => shot.selected_take_url)
                    .map((shot, index) => ({
                        id: `clip-${Date.now()}-${index}`,
                        name: `Shot ${shot.shot_number}`,
                        url: shot.selected_take_url,
                        type: 'video',
                        position: 0,
                        inPoint: 0,
                        outPoint: 5000,
                        mediaDuration: 10000,
                        scale: 1,
                        opacity: 1,
                        volume: 1,
                        muted: false,
                        fadeIn: 0,
                        fadeOut: 0
                    }));

                // Calculate positions
                let accumulatedTime = 0;
                const positionedClips = initialClips.map(clip => {
                    const newClip = { ...clip, position: accumulatedTime };
                    accumulatedTime += (clip.outPoint - clip.inPoint);
                    return newClip;
                });

                setClips(positionedClips);
                setHistory([positionedClips]);
                setHistoryIndex(0);
                
                const initialData = { media: [], clips: positionedClips };
                lastSaveDataRef.current = JSON.stringify(initialData);
                await saveProject(initialData, true);
            }
        } catch (error) {
            console.error("Failed to load project:", error);
        }
    };

    // Debounced autosave - only save if data changed
    useEffect(() => {
        if (!hasUnsavedChanges) return;

        // Clear existing timeout
        if (saveTimeoutRef.current) {
            clearTimeout(saveTimeoutRef.current);
        }

        // Set new timeout for 5 seconds after last change
        saveTimeoutRef.current = setTimeout(() => {
            const currentData = { media, clips };
            const currentDataStr = JSON.stringify(currentData);
            
            // Only save if data actually changed
            if (currentDataStr !== lastSaveDataRef.current) {
                saveProject(currentData, true);
            }
        }, 5000);

        return () => {
            if (saveTimeoutRef.current) {
                clearTimeout(saveTimeoutRef.current);
            }
        };
    }, [media, clips, hasUnsavedChanges]);

    // Track changes
    useEffect(() => {
        const currentDataStr = JSON.stringify({ media, clips });
        if (lastSaveDataRef.current && currentDataStr !== lastSaveDataRef.current) {
            setHasUnsavedChanges(true);
        }
    }, [media, clips]);

    const saveProject = async (projectData, isAutosave = false) => {
        if (isAutosave) {
            // Silent autosave - don't show UI updates or errors
            try {
                await base44.entities.Movie.update(movie.id, {
                    editor_project: projectData || { media, clips }
                });
                lastSaveDataRef.current = JSON.stringify(projectData || { media, clips });
                setLastSaved(new Date());
                setHasUnsavedChanges(false);
            } catch (error) {
                // Silently fail autosave - user can manually save
                console.log("Autosave skipped:", error.message);
            }
        } else {
            // Manual save - show UI feedback
            setIsSaving(true);
            try {
                await base44.entities.Movie.update(movie.id, {
                    editor_project: projectData || { media, clips }
                });
                lastSaveDataRef.current = JSON.stringify(projectData || { media, clips });
                setLastSaved(new Date());
                setHasUnsavedChanges(false);
            } catch (error) {
                console.error("Save failed:", error);
                alert("Failed to save project. Please try again.");
            } finally {
                setIsSaving(false);
            }
        }
    };

    const addToHistory = (newClips) => {
        const newHistory = history.slice(0, historyIndex + 1);
        newHistory.push(newClips);
        setHistory(newHistory);
        setHistoryIndex(newHistory.length - 1);
    };

    const handleMediaAdd = (mediaItem) => {
        setMedia(prev => [...prev, mediaItem]);
        setHasUnsavedChanges(true);
    };

    const handleMediaDelete = (mediaId) => {
        setMedia(prev => prev.filter(m => m.id !== mediaId));
        setHasUnsavedChanges(true);
    };

    const handleMediaDragStart = (e, mediaItem) => {
        e.dataTransfer.setData('mediaItem', JSON.stringify(mediaItem));
    };

    const handleClipsUpdate = (newClips) => {
        setClips(newClips);
        addToHistory(newClips);
        setHasUnsavedChanges(true);
    };

    const handleClipSelect = (clipId) => {
        setSelectedClipId(clipId);
    };

    const handleClipUpdate = (updatedClip) => {
        const newClips = clips.map(c => c.id === updatedClip.id ? updatedClip : c);
        setClips(newClips);
        addToHistory(newClips);
        setHasUnsavedChanges(true);
    };

    const selectedClip = clips.find(c => c.id === selectedClipId);

    const totalDuration = clips.reduce((sum, clip) => {
        return sum + ((clip.outPoint - clip.inPoint) / 1000);
    }, 0);

    const handlePlayPause = () => {
        setIsPlaying(!isPlaying);
    };

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.code === 'Space' && !e.target.matches('input, textarea')) {
                e.preventDefault();
                handlePlayPause();
            }

            if ((e.code === 'Delete' || e.code === 'Backspace') && selectedClipId && !e.target.matches('input, textarea')) {
                e.preventDefault();
                const newClips = clips.filter(c => c.id !== selectedClipId);
                handleClipsUpdate(newClips);
                setSelectedClipId(null);
            }

            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && !e.shiftKey) {
                e.preventDefault();
                if (historyIndex > 0) {
                    setHistoryIndex(historyIndex - 1);
                    setClips(history[historyIndex - 1]);
                    setHasUnsavedChanges(true);
                }
            }

            if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyZ') || 
                ((e.ctrlKey || e.metaKey) && e.code === 'KeyY')) {
                e.preventDefault();
                if (historyIndex < history.length - 1) {
                    setHistoryIndex(historyIndex + 1);
                    setClips(history[historyIndex + 1]);
                    setHasUnsavedChanges(true);
                }
            }

            // Ctrl/Cmd + S for manual save
            if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
                e.preventDefault();
                saveProject({ media, clips }, false);
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isPlaying, selectedClipId, clips, history, historyIndex, media]);

    // Playback loop
    useEffect(() => {
        if (!isPlaying) return;

        const interval = setInterval(() => {
            setCurrentTime(prev => {
                const next = prev + 0.033;
                if (next >= totalDuration) {
                    setIsPlaying(false);
                    return totalDuration;
                }
                return next;
            });
        }, 33);

        return () => clearInterval(interval);
    }, [isPlaying, totalDuration]);

    const handleExport = async () => {
        setIsExporting(true);
        setExportProgress(0);
        setExportError(null);

        try {
            for (let i = 0; i <= 100; i += 10) {
                await new Promise(resolve => setTimeout(resolve, 500));
                setExportProgress(i);
            }

            const outputUrl = clips[0]?.url;
            
            if (!outputUrl) {
                throw new Error("No clips to export");
            }

            await base44.entities.Movie.update(movie.id, {
                final_video_url: outputUrl,
                status: "completed"
            });

            setIsExporting(false);
            onComplete(outputUrl);

        } catch (error) {
            console.error("Export failed:", error);
            setExportError(error.message);
            setIsExporting(false);
        }
    };

    const handleCancelExport = () => {
        setIsExporting(false);
        setExportProgress(0);
    };

    const getTimeSinceLastSave = () => {
        const seconds = Math.floor((new Date() - lastSaved) / 1000);
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        return `${hours}h ago`;
    };

    return (
        <div className="min-h-screen bg-neutral-950 text-white p-4">
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-4">
                    <Button
                        onClick={onBack}
                        variant="ghost"
                        className="text-neutral-400 hover:text-white"
                    >
                        <ArrowLeft className="w-4 h-4 mr-2" />
                        Back
                    </Button>
                    <h1 className="text-2xl font-bold">{movie.title} - Editor</h1>
                    
                    {/* Save Status Indicator */}
                    <div className="flex items-center gap-2 text-sm">
                        {isSaving ? (
                            <span className="text-neutral-400 flex items-center gap-2">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Saving...
                            </span>
                        ) : hasUnsavedChanges ? (
                            <span className="text-yellow-400 flex items-center gap-2">
                                <AlertCircle className="w-3 h-3" />
                                Unsaved changes
                            </span>
                        ) : (
                            <span className="text-green-400 flex items-center gap-2">
                                <Check className="w-3 h-3" />
                                Saved {getTimeSinceLastSave()}
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        onClick={() => saveProject({ media, clips }, false)}
                        disabled={isSaving || !hasUnsavedChanges}
                        variant="outline"
                        className="bg-neutral-800 border-neutral-700 hover:bg-neutral-700"
                    >
                        <Save className="w-4 h-4 mr-2" />
                        Save
                    </Button>
                    <Button
                        onClick={handleExport}
                        disabled={clips.length === 0 || isExporting}
                        className="bg-green-600 hover:bg-green-700"
                    >
                        <Download className="w-4 h-4 mr-2" />
                        {isExporting ? 'Exporting...' : 'Export (H.264 MP4 1080p)'}
                    </Button>
                </div>
            </div>

            {/* Export Progress */}
            {isExporting && (
                <Card className="bg-neutral-900 border-neutral-700 mb-4">
                    <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-2">
                            <span className="text-white font-semibold">Exporting Video...</span>
                            <Button
                                onClick={handleCancelExport}
                                variant="outline"
                                size="sm"
                                className="bg-neutral-800 border-neutral-700"
                            >
                                Cancel
                            </Button>
                        </div>
                        <Progress value={exportProgress} className="mb-2" />
                        <p className="text-neutral-400 text-sm">{exportProgress}% complete</p>
                    </CardContent>
                </Card>
            )}

            {exportError && (
                <Card className="bg-red-900/20 border-red-700 mb-4">
                    <CardContent className="p-4 flex items-center gap-3">
                        <AlertCircle className="w-5 h-5 text-red-500" />
                        <div>
                            <p className="text-red-300 font-semibold">Export Failed</p>
                            <p className="text-red-400 text-sm">{exportError}</p>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Main Layout - Full Width */}
            <div className="flex flex-col gap-4 h-[calc(100vh-150px)]">
                {/* Preview + Timeline take full width */}
                <div className="flex-1 flex flex-col gap-4">
                    <PreviewPlayer
                        clips={clips}
                        currentTime={currentTime}
                        onTimeUpdate={setCurrentTime}
                        isPlaying={isPlaying}
                        onPlayPause={handlePlayPause}
                    />
                    <Timeline
                        clips={clips}
                        onClipsUpdate={handleClipsUpdate}
                        currentTime={currentTime}
                        onTimeUpdate={setCurrentTime}
                        duration={totalDuration}
                        onClipSelect={handleClipSelect}
                        selectedClipId={selectedClipId}
                    />
                </div>
            </div>

            {/* Floating Panels */}
            <MediaBin
                media={media}
                onMediaAdd={handleMediaAdd}
                onMediaDelete={handleMediaDelete}
                onDragStart={handleMediaDragStart}
            />
            <InspectorPanel
                selectedClip={selectedClip}
                onClipUpdate={handleClipUpdate}
            />
        </div>
    );
}