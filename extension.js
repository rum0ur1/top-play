const { GdkPixbuf, GObject, St, Clutter, Gio, GLib } = imports.gi;
const Slider = imports.ui.slider.Slider;
const Soup = imports.gi.Soup;
const Gst = imports.gi.Gst;
const Main = imports.ui.main;
const PanelMenu = imports.ui.panelMenu;
const ExtensionUtils = imports.misc.extensionUtils;
const Me = imports.misc.extensionUtils.getCurrentExtension();

const GETTEXT_DOMAIN = "my-indicator-extension";
const _ = ExtensionUtils.gettext;

const FRAME_COUNT = 30;
var framePixbufs = [];

// Preload all frames
for (let i = 1; i <= FRAME_COUNT; i++) {
    let name = `frame_${String(i).padStart(3, "0")}.png`;
    let filePath = `${Me.dir.get_path()}/icons/soundbar-frames/${name}`;
    try {
        let pixbuf = GdkPixbuf.Pixbuf.new_from_file(filePath);
        framePixbufs.push(pixbuf);
    } catch (e) {
        log(`Failed to load ${name}: ${e}`);
        framePixbufs.push(null);
    }
}

// --------------------------------------------------------------------------------
// Indicator: the panel button + dropdown menu
// --------------------------------------------------------------------------------
var Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(session) {
        super._init(0.5, _("Music Player"));
        this._session = session;

        this.currentPlayer = null;
        this.isPlaying = false;
        this.progressId = null;
        this._searchTimeout = null;
        this._spinLoopId = null;
        this._spinnerBin = null;
        this._currentOverlay = null;    // { wrapper, timeoutId }
        this._currentPlayingId = null;  // ID of the currently playing song

        this._renderedResults = [];
        this._currentIndex = -1;

        this._rowTimeouts = [];         // track all per-row timeouts

        // Top-bar icon
        this.icon = new St.Icon({
            icon_name: "audio-x-generic-symbolic",
            style_class: "system-status-icon",
        });
        this.icon.set_style("padding:0; padding-top:2px; margin:0;");
        this.add_child(this.icon);

        // Width of popup
        this.menu.box.set_size(300, -1);

        // Artwork + labels
        this.artworkContainer = new St.BoxLayout({
            vertical: true,
            style: "margin:10px;",
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.artwork = new St.Bin({
            style_class: "artwork",
            style: "width:270px; height:150px; background-color:#ccc;",
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.songLabel = new St.Label({
            text: "Song Name",
            style: "font-weight:bold; font-size:10pt; margin-top:4px;",
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.artistLabel = new St.Label({
            text: "Artist Name",
            style: "font-size:9pt; color:#aaa;",
            x_align: Clutter.ActorAlign.CENTER,
        });
        this.artworkContainer.add_child(this.artwork);
        this.artworkContainer.add_child(this.songLabel);
        this.artworkContainer.add_child(this.artistLabel);
        this.menu.box.add(this.artworkContainer);

        // Playback controls
        this.controlsBox = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: "controls",
            style: "margin:5px;",
        });
        this.prevBtn = this._makeButton("media-skip-backward-symbolic");
        this.prevBtn.connect("clicked", () => {
            this._artworkDirection = 'prev';
            this._playPrevious()
        });

        this.playBtn = this._makeButton("media-playback-start-symbolic");
        this.playBtn.connect("clicked", () => this._togglePlayPause());

        this.nextBtn = this._makeButton("media-skip-forward-symbolic");
        this.nextBtn.connect("clicked", () => {
            this._artworkDirection = 'next';
            this._playNext()
        });

        this.controlsBox.add_child(this.prevBtn);
        this.controlsBox.add_child(this.playBtn);
        this.controlsBox.add_child(this.nextBtn);
        this.menu.box.add(this.controlsBox);

        // Seek bar + timers
        let seekBox = new St.BoxLayout({ vertical: false, style: "margin:5px; align-items:center;" });
        this.currentTimeLabel = new St.Label({
            text: "00:00",
            x_align: Clutter.ActorAlign.START,
            style: "font-size:10pt; color:#aaa; padding-right:7px;",
        });
        this.seekBar = new Slider(0.0);
        this.seekBar.x_expand = true;
        this.seekBar.connect("drag-end", slider => {
            if (!this.currentPlayer) return;
            let [okDur, dur] = this.currentPlayer.query_duration(Gst.Format.TIME);
            if (!okDur || dur <= 0) return;
            this.currentPlayer.seek_simple(
                Gst.Format.TIME,
                Gst.SeekFlags.FLUSH | Gst.SeekFlags.KEY_UNIT,
                slider.value * dur
            );
        });
        this.totalTimeLabel = new St.Label({
            text: "00:00",
            x_align: Clutter.ActorAlign.END,
            style: "font-size:10pt; color:#aaa; padding-left:7px;",
        });
        seekBox.add_child(this.currentTimeLabel);
        seekBox.add_child(this.seekBar);
        seekBox.add_child(this.totalTimeLabel);
        this.menu.box.add(seekBox);

        // Search entry + scrollable results
        let searchEntry = new St.Entry({
            hint_text: "Search Song/Artist",
            style_class: "search-entry",
            track_hover: true,
        });
        this.menu.box.add(searchEntry);

        this.resultsBox = new St.BoxLayout({ vertical: true });
        this.scrollView = new St.ScrollView({
            style: "max-height:250px; margin:5px;",
            overlay_scrollbars: false,
        });
        this.scrollView.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        this.scrollView.add_actor(this.resultsBox);
        this.menu.box.add(this.scrollView);

        // Debounced search logic
        searchEntry.clutter_text.connect("text-changed", () => {
            if (this._searchTimeout) {
                GLib.source_remove(this._searchTimeout);
                this._searchTimeout = null;
            }
            let q = searchEntry.get_text().trim();
            if (!q) {
                this._destroySpinner();
                this._clearAllRows();
                GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this.scrollView.ease({ height: 0, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            this._createSpinner();
            this.scrollView.ease({ height: 44, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD });

            this._searchTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                fetchSongs(q, this._session)
                    .then(results => {
                        this._renderResults(results);
                        this._destroySpinner();
                    })
                    .catch(err => {
                        logError(err);
                        this._destroySpinner();
                    });
                this._searchTimeout = null;
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    // Helper: cancel all row-level timeouts and clear children
    _clearAllRows() {
        for (let id of this._rowTimeouts) {
            GLib.source_remove(id);
        }
        this._rowTimeouts = [];
        this.resultsBox.destroy_all_children();
    }

    // Remove timeouts/loops on destroy
    destroy() {
        // Cancel search debounce
        if (this._searchTimeout) {
            GLib.source_remove(this._searchTimeout);
            this._searchTimeout = null;
        }

        // Cancel progress-tracking
        if (this.progressId) {
            GLib.source_remove(this.progressId);
            this.progressId = null;
        }

        // Cancel spinner animation
        if (this._spinLoopId) {
            GLib.source_remove(this._spinLoopId);
            this._spinLoopId = null;
        }

        // Cancel current overlay animation, if any
        if (this._currentOverlay) {
            if (this._currentOverlay.timeoutId) {
                GLib.source_remove(this._currentOverlay.timeoutId);
            }
            if (this._currentOverlay.wrapper) {
                this._currentOverlay.wrapper.destroy();
            }
            this._currentOverlay = null;
        }

        // Cancel any pending row-level timeouts and clear rows
        this._clearAllRows();

        super.destroy();
    }

    _makeButton(iconName) {
        let icon = new St.Icon({
            icon_name: iconName,
            style_class: "popup-menu-icon",
            icon_size: 20
        });
        return new St.Button({
            child: icon,
            style_class: "control-button",
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER
        });
    }

    _renderResults(results) {

        this._renderedResults = results;


        // 1) Cancel previous row-level timeouts and clear rows
        this._clearAllRows();
        this._currentResults = results; // ← Save it globally

        // 2) Create each result row
        results.forEach((r, i) => {
            let artist = r.primaryArtists || "Unknown Artist";
            let dur = r.duration || 0;
            let min = Math.floor(dur / 60);
            let sec = dur % 60;
            let durationText = `${min}:${sec.toString().padStart(2, "0")}`;
            let imgSmall = r.image?.find(i => i.quality === "150x150")?.link;
            let imgBig = r.image?.find(i => i.quality === "500x500")?.link;

            // Cover placeholder
            let cover = new St.BoxLayout({
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                vertical: false,
                style_class: "cover-art",
                style: `width:48px; height:48px;
                        border-radius:4px;
                        margin-right:10px;
                        background-color:#666;`
            });

            // Song + artist labels
            let textBox = new St.BoxLayout({ vertical: true, x_expand: true });
            let songName = new St.Label({
                text: r.name,
                style: "font-weight:bold; font-size:12pt;",
            });
            songName._origStyle = songName.get_style();
            let artistName = new St.Label({
                text: artist,
                style: "font-size:9pt; color:#aaa;",
            });
            textBox.add_child(songName);
            textBox.add_child(artistName);

            // Duration label
            let durationLabel = new St.Label({
                text: durationText,
                style: "font-size:9pt; color:#ccc; margin-left:10px;",
                x_expand: false,
                x_align: Clutter.ActorAlign.END
            });

            // Row container
            let row = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                reactive: true,
                can_focus: true,
                track_hover: true
            });
            row.set_style_class_name("result-row");
            row.add_child(cover);
            row.add_child(textBox);
            row.add_child(durationLabel);

            // Store reference to reset style later
            row._songNameActor = songName;

            // If this song was already playing, restore overlay
            if (this._currentPlayingId === r.id) {
                songName.set_style("font-weight:bold; font-size:12pt; color:#38c739;");

                let image = new St.Icon({
                    gicon: null,
                    icon_size: 24,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                let wrapper = new St.Bin({
                    x_expand: true,
                    y_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: "width:26px; height:26px; padding: 6px; border-radius:4px; background-color: rgba(0, 0, 0, 0.49)",
                });
                wrapper.set_child(image);
                cover.add_child(wrapper);

                let idx = 0;
                let overlayTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                    let pixbuf = framePixbufs[idx];
                    if (pixbuf) {
                        image.set_gicon(new Gio.FileIcon({
                            file: Gio.File.new_for_path(
                                `${Me.dir.get_path()}/icons/soundbar-frames/frame_${String(idx + 1).padStart(3, "0")}.png`
                            )
                        }));
                    }
                    idx = (idx + 1) % FRAME_COUNT;
                    return GLib.SOURCE_CONTINUE;
                });

                this._currentOverlay = { wrapper, timeoutId: overlayTimeout };
            }

            // Click handler: start playback + animated overlay
            row.connect("button-press-event", () => {

                this._currentIndex = i;

                // 1) Clear existing overlay if any
                if (this._currentOverlay) {
                    GLib.source_remove(this._currentOverlay.timeoutId);
                    this._currentOverlay.wrapper.destroy();
                    this._currentOverlay = null;
                }

                // 2) Create new overlay for this row
                let image = new St.Icon({
                    gicon: null,
                    icon_size: 24,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                let wrapper = new St.Bin({
                    x_expand: true,
                    y_expand: true,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    style: "width:26px; height:26px; padding: 6px; border-radius:4px; background-color: rgba(0, 0, 0, 0.49)",
                });
                wrapper.set_child(image);
                cover.add_child(wrapper);

                // 3) Animate through preloaded pixbufs
                let idx = 0;
                let overlayTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 30, () => {
                    let pixbuf = framePixbufs[idx];
                    if (pixbuf) {
                        image.set_gicon(new Gio.FileIcon({
                            file: Gio.File.new_for_path(
                                `${Me.dir.get_path()}/icons/soundbar-frames/frame_${String(idx + 1).padStart(3, "0")}.png`
                            )
                        }));
                    }
                    idx = (idx + 1) % FRAME_COUNT;
                    return GLib.SOURCE_CONTINUE;
                });

                this._currentOverlay = { wrapper, timeoutId: overlayTimeout };

                // 4) Reset styles on all other rows
                this.resultsBox.get_children().forEach(child => {
                    child._songNameActor.set_style(child._songNameActor._origStyle);
                });

                // 5) Mark this ID as currently playing
                this._currentPlayingId = r.id;
                songName.set_style("font-weight:bold; font-size:12pt; color:#38c739;");

                // 6) Play audio
                let audioUrl = r.downloadUrl?.find(d => d.quality === "320kbps")?.link;
                if (!audioUrl) return;
                this.songLabel.set_text(r.name);
                this.artistLabel.set_text(artist);

                let offsetX = (this._artworkDirection === 'next') ? 15 : -15;

               // Fade out & slide horizontally by –offsetX (so it moves off in the correct direction)
                this.artwork.ease({
                    opacity: 0,
                    translation_x: -offsetX,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                    onComplete: () => {
                        // Swap the cover‐art image
                        this.artwork.set_style(`
                            width:270px; height:150px;
                            background-color:#ccc;
                            background-image:url("${imgBig}");
                            background-size:cover;
                        `);

                        // Position it offscreen on the opposite side (+offsetX)
                        this.artwork.set_translation(offsetX, 0, 0);

                        // Slide back in (to x = 0) and fade in
                        this.artwork.ease({
                            opacity: 255,
                            translation_x: 0,
                            duration: 250,
                            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD
                        });
                    }
                });

                this._playAudio(audioUrl);
            });

            // 7) Schedule “animate in” + “lazy-load image” timeouts and track them
            let startId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, i * 50, () => {
                row.ease({ opacity: 255, translation_y: 0, duration: 300, mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC });
                if (imgSmall) {
                    let imgId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                        cover.set_style(`
                            background-image: url("${imgSmall}");
                            background-size: cover;
                            width:48px; height:48px;
                            border-radius:4px;
                            margin-right:10px;
                        `);
                        return GLib.SOURCE_REMOVE;
                    });
                    this._rowTimeouts.push(imgId);
                }
                return GLib.SOURCE_REMOVE;
            });
            this._rowTimeouts.push(startId);

            this.resultsBox.add_child(row);
        });

        // Adjust scrollView height
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            let h = Math.min(results.length * 60, 250);
            this.scrollView.ease({ height: h, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            return GLib.SOURCE_REMOVE;
        });
    }

    _playAudio(url) {
        if (this.currentPlayer) {
            this.currentPlayer.set_state(Gst.State.NULL);
            this.currentPlayer = null;
        }
        this.currentPlayer = Gst.ElementFactory.make("playbin", "player");
        if (!this.currentPlayer) {
            log("Failed to create playbin");
            return;
        }
        this.currentPlayer.uri = url.startsWith("http") ? url : "file://" + url;
        this.currentPlayer.set_state(Gst.State.PLAYING);
        this.isPlaying = true;
        this.playBtn.child.icon_name = "media-playback-pause-symbolic";
        this._startTrackingProgress();
    }

    _startTrackingProgress() {
        if (!this.currentPlayer) return;
        if (this.progressId) {
            GLib.source_remove(this.progressId);
        }
        this.progressId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
            let [okP, pos] = this.currentPlayer.query_position(Gst.Format.TIME);
            let [okD, dur] = this.currentPlayer.query_duration(Gst.Format.TIME);
            if (okP && okD && dur > 0) {
                if (pos >= dur - Gst.MSECOND * 200) {  
                    GLib.source_remove(this.progressId);
                    this.progressId = null;
                    this.currentPlayer.set_state(Gst.State.NULL); 
                    this._artworkDirection = 'next';
                    this._playNext(); 
                    return GLib.SOURCE_REMOVE;
                }
                this.seekBar.value = pos / dur;
                let cs = Math.floor(pos / Gst.SECOND),
                    ts = Math.floor(dur / Gst.SECOND);
                this.currentTimeLabel.set_text(
                    `${String(Math.floor(cs/60)).padStart(2,"0")}:${String(cs%60).padStart(2,"0")}`
                );
                this.totalTimeLabel.set_text(
                    `${String(Math.floor(ts/60)).padStart(2,"0")}:${String(ts%60).padStart(2,"0")}`
                );
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _togglePlayPause() {
        if (!this.currentPlayer) return;
        if (this.isPlaying) {
            this.currentPlayer.set_state(Gst.State.PAUSED);
            this.isPlaying = false;
            this.playBtn.child.icon_name = "media-playback-start-symbolic";
        } else {
            this.currentPlayer.set_state(Gst.State.PLAYING);
            this.isPlaying = true;
            this.playBtn.child.icon_name = "media-playback-pause-symbolic";
        }
    }

    _playPrevious() {
        if (!this._renderedResults || this._renderedResults.length === 0) return;

        let prevIndex = this._currentIndex - 1;
        if (prevIndex < 0) {
            prevIndex = this._renderedResults.length - 1; // Loop to last song
        }

        let prevSong = this._renderedResults[prevIndex];
        if (!prevSong) return;

        // Simulate a click on the row to reuse existing play logic
        let row = this.resultsBox.get_child_at_index(prevIndex);
        if (row) {
            row.emit("button-press-event", null);
        }
    }

    _playNext() {
        if (!this._renderedResults || this._renderedResults.length === 0) return;
        let nextIndex = this._currentIndex + 1;
        if (nextIndex >= this._renderedResults.length) {
            nextIndex = 0; // Loop back to start
        }

        let nextSong = this._renderedResults[nextIndex];
        if (!nextSong) return;

        // Simulate a click on the row to reuse the existing logic
        let row = this.resultsBox.get_child_at_index(nextIndex);
        if (row) {
            row.emit("button-press-event", null);
        }
    }

    _createSpinner() {
        if (this._spinnerBin) return;
        this._spinnerIcon = new St.Icon({
            icon_name: "process-working-symbolic",
            style_class: "system-status-icon",
            style: "width:24px; height:24px; margin:10px auto;",
        });
        this._spinnerBin = new St.Bin({
            child: this._spinnerIcon,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.resultsBox.destroy_all_children();
        this.resultsBox.add_child(this._spinnerBin);

        let angle = 0;
        this._spinLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
            angle = (angle + 6) % 360;
            this._spinnerBin.set_pivot_point(0.5, 0.5);
            this._spinnerBin.set_rotation_angle(Clutter.RotateAxis.Z_AXIS, angle);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _destroySpinner() {
        if (this._spinLoopId) {
            GLib.source_remove(this._spinLoopId);
            this._spinLoopId = null;
        }
        if (this._spinnerBin) {
            this.resultsBox.remove_child(this._spinnerBin);
            this._spinnerBin = null;
            this._spinnerIcon = null;
        }
    }
});

// --------------------------------------------------------------------------------
// Fetch songs via your proxy service
// --------------------------------------------------------------------------------
function fetchSongs(query, session) {
    return new Promise((resolve, reject) => {
        let url = `https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${encodeURIComponent(query)}&limit=20`;
        let msg = Soup.Message.new("GET", url);
        msg.request_headers.append("User-Agent", "GNOME Shell Extension");
        session.queue_message(msg, (sess, m) => {
            try {
                if (m.status_code !== Soup.KnownStatusCode.OK)
                    throw new Error(`HTTP ${m.status_code}`);
                let json = JSON.parse(m.response_body.data);
                resolve(json.data?.results ?? []);
            } catch (e) {
                logError(e);
                reject(e);
            }
        });
    });
}

// --------------------------------------------------------------------------------
// Extension entry points
// --------------------------------------------------------------------------------
class Extension {
    constructor(uuid) {
        this._uuid = uuid;
        ExtensionUtils.initTranslations(GETTEXT_DOMAIN);
    }

    enable() {
        let themeContext = St.ThemeContext.get_for_stage(global.stage);
        let cssFile = Me.dir.get_child('stylesheet.css');
        themeContext.get_theme().load_stylesheet(cssFile);

        // Init GStreamer safely
        if (!Gst.is_initialized()) {
            let [ok] = Gst.init_check(null, null);
            if (!ok) log("Failed to initialize GStreamer");
        }

        // Create & store session so we can abort it
        this._session = new Soup.SessionAsync();
        this._session.add_feature(new Soup.CookieJar());

        // Instantiate indicator with our session
        this._indicator = new Indicator(this._session);
        Main.panel.addToStatusArea(this._uuid, this._indicator);
    }

    disable() {
        // Destroy UI & clear timers
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        // Abort in-flight HTTP requests
        if (this._session) {
            this._session.abort();
            this._session = null;
        }

        // CLEAN UP PIXBUFS:
        framePixbufs.forEach(p => p && p.unref && p.unref());
        framePixbufs = [];
    }
}

function init(meta) {
    return new Extension(meta.uuid);
}
