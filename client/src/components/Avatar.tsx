import React, { memo, useState, useEffect } from 'react';

/**
 * Flat, pale tints with dark ink — eight hues at least 60° apart.
 * No gradients: an avatar is an identity chip, not decoration.
 */
const AVATAR_TINTS: Array<{ bg: string; ink: string }> = [
  { bg: '#e8effa', ink: '#1b4b8f' },
  { bg: '#e6f3ec', ink: '#1c5c3f' },
  { bg: '#f7ecdf', ink: '#7c4a15' },
  { bg: '#f2e9f6', ink: '#5c3a72' },
  { bg: '#e5f2f3', ink: '#155e66' },
  { bg: '#f8e9ea', ink: '#8a2b31' },
  { bg: '#eef0e4', ink: '#4c5326' },
  { bg: '#ecebf3', ink: '#3f4275' },
];

function getTelegramColor(identifier: string): { bg: string; ink: string } {
  let hash = 0;
  for (let i = 0; i < identifier.length; i++) {
    hash = (hash * 31 + identifier.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AVATAR_TINTS.length;
  return AVATAR_TINTS[index];
}

function getInitials(name?: string): string {
  if (!name) return '?';
  const clean = name.replace(/^[@+]/, '').trim();
  if (!clean) return '?';
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

interface AvatarProps {
  name?: string;
  id?: string;
  photoUrl?: string | null;
  size?: number;
  isOnline?: boolean;
}

export const Avatar: React.FC<AvatarProps> = memo(({ name = '', id = '', photoUrl, size = 44, isOnline }) => {
  const [imgFailed, setImgFailed] = useState(false);
  const identifier = id || name || 'unknown';
  const tint = getTelegramColor(identifier);
  const initials = getInitials(name || identifier);

  useEffect(() => {
    setImgFailed(false);
  }, [photoUrl]);

  const hasPhoto = Boolean(photoUrl && !imgFailed);

  return (
    <div
      className="tg-avatar-container"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        minWidth: `${size}px`,
        minHeight: `${size}px`,
      }}
    >
      {hasPhoto ? (
        <img
          src={photoUrl!}
          alt={name}
          loading="lazy"
          decoding="async"
          className="tg-avatar-img"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div
          className="tg-avatar-placeholder"
          style={{
            background: tint.bg,
            color: tint.ink,
            fontSize: `${Math.round(size * 0.42)}px`,
          }}
        >
          {initials}
        </div>
      )}
      {isOnline && <span className="tg-avatar-online-pip" />}
    </div>
  );
});

Avatar.displayName = 'Avatar';
