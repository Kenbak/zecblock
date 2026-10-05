'use client';

import { readApiData } from '@/lib/api-client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { STAKING_DAY_PERIOD, STAKING_DAY_WINDOW, STAKING_ACTIVATION_HEIGHT } from '@/lib/config';
import { getApiUrl } from '@/lib/api-config';
import { Tooltip } from '@/components/Tooltip';

interface StakingDayInfo {
  tipHeight: number;
  positionInPeriod: number;
  isStakingOpen: boolean;
  blocksRemaining: number;
  blocksUntilNextWindow: number;
  periodNumber: number;
}

function computeStakingDay(tipHeight: number): StakingDayInfo {
  const periodNumber = Math.floor(tipHeight / STAKING_DAY_PERIOD);
  const positionInPeriod = tipHeight % STAKING_DAY_PERIOD;
  const isStakingOpen = tipHeight >= STAKING_ACTIVATION_HEIGHT && positionInPeriod < STAKING_DAY_WINDOW;

  return {
    tipHeight,
    positionInPeriod,
    isStakingOpen,
    blocksRemaining: isStakingOpen ? STAKING_DAY_WINDOW - positionInPeriod : 0,
    blocksUntilNextWindow: isStakingOpen ? 0 : tipHeight < STAKING_ACTIVATION_HEIGHT ? STAKING_ACTIVATION_HEIGHT - tipHeight : STAKING_DAY_PERIOD - positionInPeriod,
    periodNumber,
  };
}

const NOTIFY_KEY = 'staking-notify';

function getNotifyPref(): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(NOTIFY_KEY) === 'on';
}

function setNotifyPref(on: boolean) {
  localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off');
}

type PermState = 'default' | 'granted' | 'denied' | 'unsupported';

function getPermState(): PermState {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission as PermState;
}

function fireNotification(period: number) {
  if (getPermState() !== 'granted') return;
  try {
    new Notification('Staking window is open', {
      body: `Period #${period} — ${STAKING_DAY_WINDOW} blocks to stake, unstake, or withdraw.`,
      icon: '/icon.png',
      tag: `staking-period-${period}`,
    });
  } catch {
    // Silent — some environments block Notification constructor
  }
}

export function StakingDayBanner() {
  const [staking, setStaking] = useState<StakingDayInfo | null>(null);
  const [notifyOn, setNotifyOn] = useState(false);
  const [perm, setPerm] = useState<PermState>('default');
  const prevOpenRef = useRef<boolean | null>(null);

  useEffect(() => {
    setPerm(getPermState());
    setNotifyOn(getNotifyPref());
  }, []);

  const fetchTip = useCallback(async () => {
    try {
      const res = await fetch(`${getApiUrl()}/v1/crosslink`);
      if (!res.ok) return;
      const data = await readApiData(res);
      if (data && data.tipHeight != null) {
        setStaking(computeStakingDay(data.tipHeight));
      }
    } catch {}
  }, []);

  useEffect(() => {
    fetchTip();
    const interval = setInterval(fetchTip, 15000);
    return () => clearInterval(interval);
  }, [fetchTip]);

  // Detect staking window transition: closed -> open
  useEffect(() => {
    if (!staking || !notifyOn) return;
    const wasOpen = prevOpenRef.current;
    prevOpenRef.current = staking.isStakingOpen;
    if (wasOpen === false && staking.isStakingOpen) {
      fireNotification(staking.periodNumber);
    }
  }, [staking, notifyOn]);

  const handleNotifyToggle = useCallback(async () => {
    if (notifyOn) {
      setNotifyOn(false);
      setNotifyPref(false);
      return;
    }

    const currentPerm = getPermState();
    if (currentPerm === 'unsupported') return;

    if (currentPerm === 'granted') {
      setNotifyOn(true);
      setNotifyPref(true);
      setPerm('granted');
      return;
    }

    if (currentPerm === 'denied') {
      setPerm('denied');
      return;
    }

    // 'default' — ask for permission
    const result = await Notification.requestPermission();
    setPerm(result as PermState);
    if (result === 'granted') {
      setNotifyOn(true);
      setNotifyPref(true);
    }
  }, [notifyOn]);

  if (!staking) return null;

  const progressPercent = staking.isStakingOpen
    ? (staking.positionInPeriod / STAKING_DAY_WINDOW) * 100
    : ((staking.positionInPeriod - STAKING_DAY_WINDOW) / (STAKING_DAY_PERIOD - STAKING_DAY_WINDOW)) * 100;

  return (
    <div className={`card p-4 border ${
      staking.isStakingOpen
        ? 'border-cipher-green/30 bg-cipher-green/5'
        : 'border-cipher-border'
    }`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          {staking.isStakingOpen ? (
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cipher-green opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-cipher-green"></span>
            </span>
          ) : (
            <span className="inline-flex rounded-full h-2.5 w-2.5 bg-muted/50"></span>
          )}
          <span className="text-xs font-mono font-semibold uppercase tracking-wider flex items-center gap-1">
            {staking.isStakingOpen ? (
              <span className="text-cipher-green">Staking Window Open</span>
            ) : (
              <span className="text-muted"> {staking.tipHeight < STAKING_ACTIVATION_HEIGHT ? `Staking opens at #${STAKING_ACTIVATION_HEIGHT.toLocaleString()}` : 'Staking Window Closed'}</span>
            )}
            <Tooltip content={`Staking actions (stake, unstake, withdraw) are only allowed during "Staking Day" windows. Every ${STAKING_DAY_PERIOD} blocks, a ${STAKING_DAY_WINDOW}-block window opens for staking operations.`} />
          </span>
        </div>
        <div className="flex items-center gap-3">
          <NotifyButton
            perm={perm}
            notifyOn={notifyOn}
            onToggle={handleNotifyToggle}
          />
          <span className="text-caption font-mono text-muted">
            Period #{staking.periodNumber}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="relative h-2 rounded-full bg-cipher-border-alpha/50 overflow-hidden mb-2">
        <div
          className={`absolute top-0 left-0 h-full rounded-full transition-[width] duration-500 ${
            staking.isStakingOpen ? 'bg-cipher-green' : 'bg-muted'
          }`}
          style={{ width: `${Math.max(0, Math.min(progressPercent, 100))}%` }}
        />
      </div>

      <div className="flex items-center justify-between text-caption font-mono text-muted">
        <span>
          Block {staking.positionInPeriod}/{staking.isStakingOpen ? STAKING_DAY_WINDOW : STAKING_DAY_PERIOD}
        </span>
        {staking.isStakingOpen ? (
          <span className="text-cipher-green">
            {staking.blocksRemaining} blocks remaining
          </span>
        ) : (
          <span>
            Next window in {staking.blocksUntilNextWindow} blocks
          </span>
        )}
      </div>
    </div>
  );
}

function NotifyButton({
  perm,
  notifyOn,
  onToggle,
}: {
  perm: PermState;
  notifyOn: boolean;
  onToggle: () => void;
}) {
  if (perm === 'unsupported') return null;

  if (perm === 'denied') {
    return (
      <span className="text-caption font-mono text-muted flex items-center gap-1 cursor-not-allowed" title="Notifications blocked in browser settings">
        <BellSlashIcon />
        <span className="hidden sm:inline">Blocked</span>
      </span>
    );
  }

  if (notifyOn) {
    return (
      <button
        onClick={onToggle}
        className="text-caption font-mono text-cipher-green flex items-center gap-1 hover:opacity-80 transition-opacity"
        title="Click to disable staking notifications"
      >
        <BellActiveIcon />
        <span className="hidden sm:inline">Notify on</span>
      </button>
    );
  }

  return (
    <button
      onClick={onToggle}
      className="text-caption font-mono text-secondary flex items-center gap-1 hover:text-primary transition-colors"
      title="Get a browser notification when the staking window opens"
    >
      <BellIcon />
      <span className="hidden sm:inline">Notify me</span>
    </button>
  );
}

function BellIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 14.5c.83 0 1.5-.67 1.5-1.5h-3c0 .83.67 1.5 1.5 1.5Z" />
      <path d="M13 11c-.75-.75-1.5-1.5-1.5-5A3.5 3.5 0 0 0 8 2.5 3.5 3.5 0 0 0 4.5 6c0 3.5-.75 4.25-1.5 5h10Z" />
    </svg>
  );
}

function BellActiveIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" strokeWidth="0.5">
      <path d="M8 14.5c.83 0 1.5-.67 1.5-1.5h-3c0 .83.67 1.5 1.5 1.5Z" />
      <path d="M13 11c-.75-.75-1.5-1.5-1.5-5A3.5 3.5 0 0 0 8 2.5 3.5 3.5 0 0 0 4.5 6c0 3.5-.75 4.25-1.5 5h10Z" />
    </svg>
  );
}

function BellSlashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 14.5c.83 0 1.5-.67 1.5-1.5h-3c0 .83.67 1.5 1.5 1.5Z" />
      <path d="M13 11c-.75-.75-1.5-1.5-1.5-5A3.5 3.5 0 0 0 8 2.5 3.5 3.5 0 0 0 4.5 6c0 3.5-.75 4.25-1.5 5h10Z" />
      <line x1="2" y1="2" x2="14" y2="14" />
    </svg>
  );
}
