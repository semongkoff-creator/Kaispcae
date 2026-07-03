import { useEffect, useRef, useCallback } from 'react';
import { AvatarConfig, BodyShape, Accessory, Expression } from '@virtualmeet/shared';

const STORAGE_KEY = 'virtualmeet-avatar-config';

export const PALETTE = [
  '#ff6b6b', '#4ecdc4', '#ffe66d', '#a786df',
  '#6bcb77', '#4d96ff', '#ff9f43', '#ee5a24',
  '#0abde3', '#10ac84', '#f368e0', '#576574',
];

const DEFAULT_CONFIG: AvatarConfig = {
  bodyShape: 'circle',
  color: PALETTE[0],
  accessory: 'none',
  expression: 'neutral',
  name: 'You',
  statusTag: '',
};

export function loadAvatarConfig(): AvatarConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch { /* ignore corrupt data */ }
  return { ...DEFAULT_CONFIG };
}

export function saveAvatarConfig(config: AvatarConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function useAvatarConfig() {
  const configRef = useRef<AvatarConfig>(loadAvatarConfig());

  const getConfig = useCallback(() => configRef.current, []);

  const updateConfig = useCallback((partial: Partial<AvatarConfig>) => {
    configRef.current = { ...configRef.current, ...partial };
    saveAvatarConfig(configRef.current);
    return configRef.current;
  }, []);

  const resetConfig = useCallback(() => {
    configRef.current = { ...DEFAULT_CONFIG };
    saveAvatarConfig(configRef.current);
    return configRef.current;
  }, []);

  useEffect(() => {
    configRef.current = loadAvatarConfig();
  }, []);

  return { getConfig, updateConfig, resetConfig, DEFAULT_CONFIG, PALETTE };
}
