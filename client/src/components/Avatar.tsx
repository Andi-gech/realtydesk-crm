import React, { memo, useState, useEffect } from 'react';

const TELEGRAM_GRADIENTS = [
  'linear-gradient(135deg, #ff885e 0%, #ff516a 100%)', // Red
  'linear-gradient(135deg, #ffaa42 0%, #ff6e2e 100%)', // Orange
  'linear-gradient(135deg, #a665ff 0%, #7645ff 100%)', // Violet
  'linear-gradient(135deg, #51e29e 0%, #2ac275 100%)', // Green
  'linear-gradient(135deg, #4bd1f2 0%, #17a9e0 100%)', // Cyan
  'linear-gradient(135deg, #56b5f5 0%, #2a8be8 100%)', // Blue
  'linear-gradient(135deg, #f767a6 0%, #e03884 100%)', // Pink
];

function getTelegramColor(identifier: string): string {
  let hash = 0;
  for (let i = 0; i < identifier.length; i++) {
    hash = (hash * 31 + identifier.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % TELEGRAM_GRADIENTS.length;
  return TELEGRAM_GRADIENTS[index];
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
  const background = getTelegramColor(identifier);
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
          className="tg-avatar-img"
          onError={() => setImgFailed(true)}
        />
      ) : (
        <div
          className="tg-avatar-placeholder"
          style={{
            background,
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
