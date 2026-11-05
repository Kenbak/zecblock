"use client";
import { createContext, useContext } from "react";
export type CrosschainVenue = "near" | "maya" | "thorchain";
export const CrosschainVenueContext = createContext<CrosschainVenue>("near");
export const useCrosschainVenue = () => useContext(CrosschainVenueContext);

/** Preserve the selected dataset in every ordinary filter/pagination link. */
export function scopeVenueHref(href: string, venue: CrosschainVenue) {
  if (venue === "near" || !/^\/crosschain(?:[?#]|$)/.test(href)) return href;
  const [pathAndQuery, hash] = href.split("#", 2);
  const [path, query = ""] = pathAndQuery.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("venue", venue);
  return `${path}?${params.toString()}${hash ? `#${hash}` : ""}`;
}
