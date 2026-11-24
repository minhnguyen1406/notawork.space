import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  VideoQuality,
  type Participant,
  type RemoteTrackPublication,
  type TrackPublication,
} from 'livekit-client';

/** How one other person relates to you right now. */
export interface Near {
  dist: number;
  /** Seated in the same face-grid group as you. */
  together: boolean;
}

export interface MediaHooks {
  /** A person's live camera appeared (element) or went away (null). */
  camera(id: string, el: HTMLVideoElement | null): void;
  /** Something is being shared to the cinema screen (element), or sharing stopped (null). */
  screen(el: HTMLVideoElement | null): void;
  speaking(ids: Set<string>): void;
  /** Any change that the face grid or buttons might care about. */
  changed(): void;
}

const HEAR_RANGE = 12; // beyond this you neither hear nor see someone
const FULL_VOLUME_RANGE = 3;
const MAX_VIDEOS = 8;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * Voice, video and screenshare through LiveKit. Nothing is subscribed automatically:
 * you only receive the people near you, which keeps bandwidth low with 20 in the room.
 */
export class Media {
  private room = new Room({
    adaptiveStream: false, // camera feeds are drawn as 3D textures, which adaptive stream can't see
    dynacast: true,
    videoCaptureDefaults: { resolution: VideoPresets.h360.resolution },
  });
  private voices = new Map<string, HTMLAudioElement>();
  private quality = new Map<string, VideoQuality>();
  private screenAudio: HTMLAudioElement | null = null;
  private screenOwner: string | null = null;
  /** 0 to 1. Set by the game from how close you are to the cinema screen. */
  screenVolume = 0;

  constructor(
    private myId: string,
    private hooks: MediaHooks,
  ) {}

  async connect(url: string, token: string) {
    const r = this.room;
    r.on(RoomEvent.TrackPublished, (pub) => this.alwaysWant(pub))
      .on(RoomEvent.TrackSubscribed, (track, pub, p) => {
        const el = track.attach();
        switch (pub.source) {
          case Track.Source.Microphone:
            (el as HTMLAudioElement).volume = 0;
            document.body.append(el);
            this.voices.set(p.identity, el as HTMLAudioElement);
            break;
          case Track.Source.Camera:
            if (!pub.isMuted) this.hooks.camera(p.identity, el as HTMLVideoElement);
            break;
          case Track.Source.ScreenShare:
            this.screenOwner = p.identity;
            this.hooks.screen(el as HTMLVideoElement);
            break;
          case Track.Source.ScreenShareAudio:
            (el as HTMLAudioElement).volume = this.screenVolume;
            document.body.append(el);
            this.screenAudio = el as HTMLAudioElement;
            break;
        }
        this.hooks.changed();
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub, p) => {
        track.detach().forEach((el) => el.remove());
        switch (pub.source) {
          case Track.Source.Microphone:
            this.voices.delete(p.identity);
            break;
          case Track.Source.Camera:
            this.hooks.camera(p.identity, null);
            break;
          case Track.Source.ScreenShare:
            if (this.screenOwner === p.identity) {
              this.screenOwner = null;
              this.hooks.screen(null);
            }
            break;
          case Track.Source.ScreenShareAudio:
            this.screenAudio = null;
            break;
        }
        this.hooks.changed();
      })
      .on(RoomEvent.TrackMuted, (pub, p) => this.onCameraMute(pub, p, true))
      .on(RoomEvent.TrackUnmuted, (pub, p) => this.onCameraMute(pub, p, false))
      .on(RoomEvent.LocalTrackPublished, (pub) => this.onLocal(pub, true))
      .on(RoomEvent.LocalTrackUnpublished, (pub) => this.onLocal(pub, false))
      .on(RoomEvent.ParticipantDisconnected, (p) => {
        this.quality.delete(p.identity);
        this.hooks.changed();
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => this.hooks.speaking(new Set(speakers.map((s) => s.identity))));

    await r.connect(url, token, { autoSubscribe: false });
    r.remoteParticipants.forEach((p) => p.trackPublications.forEach((pub) => this.alwaysWant(pub)));
    void r.startAudio().catch(() => {});
  }

  /** Screenshares are for the whole room, so always receive them. */
  private alwaysWant(pub: RemoteTrackPublication) {
    if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) pub.setSubscribed(true);
  }

  private onCameraMute(pub: TrackPublication, p: Participant, muted: boolean) {
    if (pub.source !== Track.Source.Camera) return;
    if (muted) {
      pub.track?.detach().forEach((el) => el.remove());
      this.hooks.camera(p.identity, null);
    } else if (pub.track) {
      this.hooks.camera(p.identity, pub.track.attach() as HTMLVideoElement);
    }
    this.hooks.changed();
  }

  private onLocal(pub: TrackPublication, published: boolean) {
    if (pub.source === Track.Source.Camera) {
      this.hooks.camera(this.myId, published && pub.track ? (pub.track.attach() as HTMLVideoElement) : null);
    } else if (pub.source === Track.Source.ScreenShare) {
      if (published && pub.track) {
        this.screenOwner = this.myId;
        this.hooks.screen(pub.track.attach() as HTMLVideoElement);
      } else if (this.screenOwner === this.myId) {
        this.screenOwner = null;
        this.hooks.screen(null);
      }
    }
    this.hooks.changed();
  }

  private participant(id: string): Participant | undefined {
    return id === this.myId ? this.room.localParticipant : this.room.remoteParticipants.get(id);
  }

  private extra = new Map<HTMLMediaElement, Track>();

  private extraElement(track: Track | undefined): HTMLVideoElement | null {
    if (!track) return null;
    const el = track.attach() as HTMLVideoElement;
    this.extra.set(el, track);
    return el;
  }

  /** A fresh <video> for someone's camera, for the face grid. Null if their camera is off or out of range. */
  attachCamera(id: string): HTMLVideoElement | null {
    const pub = this.participant(id)?.getTrackPublication(Track.Source.Camera);
    if (!pub || pub.isMuted) return null;
    return this.extraElement(pub.track);
  }

  /** A fresh <video> for the current screenshare, for full-screen viewing. */
  attachScreen(): HTMLVideoElement | null {
    if (!this.screenOwner) return null;
    return this.extraElement(this.participant(this.screenOwner)?.getTrackPublication(Track.Source.ScreenShare)?.track);
  }

  /** Give back an element from attachCamera or attachScreen. */
  release(el: HTMLMediaElement) {
    this.extra.get(el)?.detach(el);
    this.extra.delete(el);
    el.remove();
  }

  get hasScreen() {
    return this.screenOwner !== null;
  }
  get sharingMyScreen() {
    return this.screenOwner === this.myId;
  }

  async setMic(on: boolean) {
    const p = this.room.localParticipant;
    if (p.isMicrophoneEnabled !== on) await p.setMicrophoneEnabled(on);
  }

  async toggleCamera() {
    const p = this.room.localParticipant;
    await p.setCameraEnabled(!p.isCameraEnabled);
    return p.isCameraEnabled;
  }

  async toggleScreen() {
    const p = this.room.localParticipant;
    await p.setScreenShareEnabled(!p.isScreenShareEnabled, { audio: true, contentHint: 'motion' });
    return p.isScreenShareEnabled;
  }

  /** Called a few times a second with everyone else's distance from you. */
  updateProximity(near: Map<string, Near>) {
    const inRange = [...near].filter(([, n]) => n.together || n.dist < HEAR_RANGE).sort((a, b) => a[1].dist - b[1].dist);
    const see = new Set(inRange.filter(([, n]) => n.together).map(([id]) => id));
    for (const [id] of inRange) {
      if (see.size >= MAX_VIDEOS) break;
      see.add(id);
    }

    this.room.remoteParticipants.forEach((p) => {
      const n = near.get(p.identity);
      const hear = !!n && (n.together || n.dist < HEAR_RANGE);

      const mic = p.getTrackPublication(Track.Source.Microphone);
      if (mic && mic.isDesired !== hear) mic.setSubscribed(hear);

      const cam = p.getTrackPublication(Track.Source.Camera);
      if (cam) {
        const want = see.has(p.identity);
        if (cam.isDesired !== want) cam.setSubscribed(want);
        if (want) {
          const q = n!.together ? VideoQuality.HIGH : VideoQuality.LOW;
          if (this.quality.get(p.identity) !== q) {
            this.quality.set(p.identity, q);
            cam.setVideoQuality(q);
          }
        } else {
          this.quality.delete(p.identity);
        }
      }

      const voice = this.voices.get(p.identity);
      if (voice && n) {
        voice.volume = n.together ? 1 : clamp01(1 - (n.dist - FULL_VOLUME_RANGE) / (HEAR_RANGE - FULL_VOLUME_RANGE));
      }
    });

    if (this.screenAudio) this.screenAudio.volume = clamp01(this.screenVolume);
  }
}
