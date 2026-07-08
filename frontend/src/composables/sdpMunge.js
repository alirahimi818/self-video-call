// Force Opus DTX + a conservative average bitrate so audio survives even
// when the link is too poor for video. Browsers don't expose these Opus
// fmtp params through setParameters(), so we edit the SDP directly.
export function mungeOpusFmtp(sdp, { maxaveragebitrate = 16000, usedtx = 1 } = {}) {
  const lines = sdp.split('\r\n');
  const opusRtpmap = lines.find((line) => /a=rtpmap:\d+ opus\/48000/i.test(line));
  if (!opusRtpmap) return sdp;

  const payloadType = opusRtpmap.match(/a=rtpmap:(\d+) opus\/48000/i)[1];
  const fmtpIndex = lines.findIndex((line) => line.startsWith(`a=fmtp:${payloadType} `));

  if (fmtpIndex === -1) {
    const rtpmapIndex = lines.indexOf(opusRtpmap);
    lines.splice(
      rtpmapIndex + 1,
      0,
      `a=fmtp:${payloadType} maxaveragebitrate=${maxaveragebitrate};usedtx=${usedtx};useinbandfec=1`,
    );
  } else {
    const existing = lines[fmtpIndex];
    const params = new Map(
      existing
        .slice(existing.indexOf(' ') + 1)
        .split(';')
        .filter(Boolean)
        .map((pair) => pair.split('=')),
    );
    params.set('maxaveragebitrate', String(maxaveragebitrate));
    params.set('usedtx', String(usedtx));
    if (!params.has('useinbandfec')) params.set('useinbandfec', '1');
    const rebuilt = [...params.entries()].map(([k, v]) => `${k}=${v}`).join(';');
    lines[fmtpIndex] = `a=fmtp:${payloadType} ${rebuilt}`;
  }

  return lines.join('\r\n');
}
