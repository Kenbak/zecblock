/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';
// Icon-only copy control (plain module so node tests can render it). The label
// names what is copied for assistive technology; styling comes from the caller.
const React = require('react');
const h = React.createElement;
const copyIcon = h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
  h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
  h('path', { d: 'M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }));
const checkIcon = h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
  h('path', { d: 'M3.5 8.5l3 3 6-7', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }));
function CopyButton({ text, label, className }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => { if (!copied) return undefined; const timer = setTimeout(() => setCopied(false), 1800); return () => clearTimeout(timer); }, [copied]);
  const copy = () => { navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false)); };
  return h('button', { type: 'button', className, onClick: copy, 'aria-label': copied ? `${label} copied` : `Copy ${label}`, title: copied ? 'Copied' : `Copy ${label}` },
    copied ? checkIcon : copyIcon, h('span', { className: 'sr-only', role: 'status' }, copied ? 'Copied' : ''));
}
module.exports = { CopyButton };
