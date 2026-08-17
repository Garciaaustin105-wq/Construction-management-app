"use client";

// Address text input backed by Google Places Autocomplete (Places API). A drop-
// in replacement for the plain `<input value={address} onChange={...}>` used on
// the customer/job forms — typing shows Google address predictions, and picking
// one fills the field with the verified `formatted_address`. When the place has
// a geometry.location, onPlaceSelect fires with the lat/lng so a caller that
// already knows the job id (e.g. JobDetailsEditor) can save the lawn_jobs pin
// directly, skipping the separate geocode step.
//
// Resilient: if the Google key is unset or the Places library fails to load,
// the field degrades to an ordinary controlled text input — forms keep working,
// the caller just loses autocomplete + pin capture. The Autocomplete widget
// manages per-session billing internally (no manual session token needed).
//
// Google Places touches window — but Autocomplete attaches to a real <input> in
// the DOM, so (unlike the map) this component can render server-side as a plain
// input and upgrade after mount. We keep the input always rendered; the
// Autocomplete overlay is attached once Google is ready.

import { useEffect, useRef } from "react";
import { loadGoogleMaps } from "@/lib/googleMaps";

type PlaceSelected = {
  formattedAddress: string;
  lat: number;
  lng: number;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  name?: string;
  id?: string;
  className?: string;
  // Fired when the user picks a prediction that resolves to a lat/lng. Lets a
  // caller with a known job id save the pin immediately (see JobDetailsEditor).
  onPlaceSelect?: (place: PlaceSelected) => void;
  // Allows autocomplete="street-address" etc. callers to control the attr.
  autoComplete?: string;
};

export default function AddressInput({
  value,
  onChange,
  placeholder,
  name,
  id,
  className,
  onPlaceSelect,
  autoComplete,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const acRef = useRef<google.maps.places.Autocomplete | null>(null);
  const listenerRef = useRef<google.maps.MapsEventListener | null>(null);
  // Keep the latest onPlaceSelect in a ref so re-init isn't triggered when the
  // parent recreates the handler (assigned in a deps-free effect, not during
  // render — react-hooks/refs forbids writing refs during render).
  const onPlaceSelectRef = useRef(onPlaceSelect);

  useEffect(() => {
    onPlaceSelectRef.current = onPlaceSelect;
  });

  useEffect(() => {
    let cancelled = false;
    if (!inputRef.current) return;
    loadGoogleMaps()
      .then((g) => {
        if (cancelled || !inputRef.current || acRef.current) return;
        const ac = new g.maps.places.Autocomplete(inputRef.current, {
          types: ["address"],
          // Only fetch the fields we use — minimizes per-selection SKU cost.
          fields: ["formatted_address", "geometry.location"],
        });
        listenerRef.current = ac.addListener("place_changed", () => {
          const place = ac.getPlace();
          const addr = place?.formatted_address;
          if (addr) onChange(addr);
          const loc = place?.geometry?.location;
          if (loc && typeof loc.lat === "function" && typeof loc.lng === "function") {
            onPlaceSelectRef.current?.({
              formattedAddress: addr ?? "",
              lat: loc.lat(),
              lng: loc.lng(),
            });
          }
        });
        acRef.current = ac;
      })
      .catch(() => {
        // Key missing / Places unavailable — leave the plain controlled input.
        // Non-fatal: the field still works as a normal text input.
      });
    return () => {
      cancelled = true;
      listenerRef.current?.remove();
      listenerRef.current = null;
      // google.maps.event.clearInstanceListeners would also drop the Autocomplete
      // listeners, but remove() on the stored handle is enough + safe here.
      acRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const inputClasses =
    className ??
    "w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500";

  return (
    <input
      ref={inputRef}
      type="text"
      name={name}
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      autoComplete={autoComplete ?? "street-address"}
      className={inputClasses}
      inputMode="text"
    />
  );
}