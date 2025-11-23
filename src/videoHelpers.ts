export function extractYouTubeEmbedUrl(url: string): string | null {
  try {
    const trimmed = url.trim();
    if (!trimmed) return null;

    // youtu.be/VIDEO_ID
    const shortMatch = trimmed.match(/youtu\.be\/([a-zA-Z0-9_-]{6,})/);
    if (shortMatch) {
      return `https://www.youtube.com/embed/${shortMatch[1]}`;
    }

    // youtube.com/watch?v=VIDEO_ID
    const watchMatch = trimmed.match(/[?&]v=([a-zA-Z0-9_-]{6,})/);
    if (watchMatch) {
      return `https://www.youtube.com/embed/${watchMatch[1]}`;
    }

    // already an embed URL
    const embedMatch = trimmed.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{6,})/);
    if (embedMatch) {
      return trimmed;
    }

    return null;
  } catch {
    return null;
  }
}


