"use client";

/**
 * LawnMeasurementMap
 *
 * A client‑side component that renders a Google Map and lets the user
 * draw a polygon to estimate lawn square footage. The component handles
 * map loading, geocoding, live area calculation, and persisting the
 * measurement via Supabase.
 */

import { useEffect, useState, useRef } from "react";
import type React from "react";
import { loadGoogleMaps } from "@/lib/googleMaps";
import {
  polygonAreaSqft,
  saveEstimateMeasurement,
} from "@/lib/lawnMeasurement";
import { createClient } from "@/lib/supabase/client";

export default function LawnMeasurementMap({
  estimateId,
  address,
  initial,
}: {
  estimateId: string;
  address: string | null;
  initial?: { measured_sqft: number | null; map_lat: number | null; map_lng: number | null } | null;
}): React.ReactElement {
  const mapRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const [vertices, setVertices] = useState<google.maps.LatLngLiteral[]>([]);
  const [areaSqft, setAreaSqft] = useState<number>(0);
  const [isDrawing, setIsDrawing] = useState<boolean>(true);
  const [saveStatus, setSaveStatus] = useState<{ message: string | null; error: string | null }>({
    message: null,
    error: null,
  });
  const [savedArea, setSavedArea] = useState<number | null>(null);

  const polygonRef = useRef<google.maps.Polygon | null>(null);
  const markersRef = useRef<google.maps.Marker[]>([]);
  const isDrawingRef = useRef(isDrawing);
  useEffect(() => {
    isDrawingRef.current = isDrawing;
  }, [isDrawing]);

  // Load Google Maps JS API
  useEffect(() => {
    loadGoogleMaps()
      .then(() => setError(null))
      .catch((e) => setError(e.message));
  }, []);

  // Create map once Google Maps is available
  useEffect(() => {
    if (!mapRef.current || map) return;
    const initMap = () => {
      const fallbackCenter = new google.maps.LatLng(27.9506, -82.4572);
      const createMap = (center: google.maps.LatLng) => {
        const m = new google.maps.Map(mapRef.current!, {
          center,
          zoom: 18,
        });
        setMap(m);
        m.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (!isDrawingRef.current || !e.latLng) return;
          const newVertex = { lat: e.latLng.lat(), lng: e.latLng.lng() };
          setVertices((prev) => [...prev, newVertex]);
        });
      };

      if (!address) {
        createMap(fallbackCenter);
      } else {
        const geocoder = new google.maps.Geocoder();
        geocoder.geocode({ address }, (results, status) => {
          const center =
            status === "OK" && results && results[0]
              ? results[0].geometry.location
              : fallbackCenter;
          createMap(center);
        });
      }
    };
    initMap();
  }, [address, map]);

  // Update polygon and markers when vertices change
  useEffect(() => {
    if (!map) return;

    // Remove existing polygon
    if (polygonRef.current) {
      polygonRef.current.setMap(null);
      polygonRef.current = null;
    }
    // Remove existing markers
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    if (vertices.length === 0) {
      setAreaSqft(0);
      return;
    }

    // Create markers
    vertices.forEach((v) => {
      const marker = new google.maps.Marker({
        position: v,
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 3,
          fillColor: "#4285F4",
          fillOpacity: 1,
          strokeWeight: 0,
        },
      });
      markersRef.current.push(marker);
    });

    // Create polygon
    const polygon = new google.maps.Polygon({
      paths: vertices,
      strokeColor: "#4285F4",
      strokeOpacity: 0.8,
      strokeWeight: 2,
      fillColor: "#4285F4",
      fillOpacity: 0.35,
      map,
    });
    polygonRef.current = polygon;

    // Compute area
    const area = polygonAreaSqft(
      vertices.map((v) => new google.maps.LatLng(v.lat, v.lng))
    );
    setAreaSqft(area);
  }, [vertices, map]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (polygonRef.current) polygonRef.current.setMap(null);
      markersRef.current.forEach((m) => m.setMap(null));
    };
  }, []);

  const clear = () => {
    setVertices([]);
    setIsDrawing(true);
    setAreaSqft(0);
    setSavedArea(null);
    setSaveStatus({ message: null, error: null });
    if (polygonRef.current) {
      polygonRef.current.setMap(null);
      polygonRef.current = null;
    }
    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];
  };

  const saveMeasurement = async () => {
    if (!map || vertices.length < 3) return;
    const centerLat =
      vertices.reduce((sum, v) => sum + v.lat, 0) / vertices.length;
    const centerLng =
      vertices.reduce((sum, v) => sum + v.lng, 0) / vertices.length;
    const supabase = createClient();
    const err = await saveEstimateMeasurement(supabase, estimateId, {
      measured_sqft: areaSqft,
      map_lat: centerLat,
      map_lng: centerLng,
    });
    if (err) {
      setSaveStatus({ message: null, error: err });
    } else {
      setSaveStatus({
        message: `Saved — ${areaSqft.toLocaleString()} sq ft`,
        error: null,
      });
      setSavedArea(areaSqft);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-2 bg-red-100 text-red-800 rounded">
          Error: {error}
        </div>
      )}
      <div
        ref={mapRef}
        className="w-full h-96 rounded shadow"
      />
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setIsDrawing(false)}
          disabled={vertices.length < 3}
          className="px-3 py-1 bg-blue-500 text-white rounded disabled:opacity-50"
        >
          Close shape
        </button>
        <button
          onClick={clear}
          className="px-3 py-1 bg-gray-500 text-white rounded"
        >
          Clear
        </button>
        <button
          onClick={saveMeasurement}
          disabled={isDrawing || vertices.length < 3}
          className="px-3 py-1 bg-green-500 text-white rounded disabled:opacity-50"
        >
          Save measurement
        </button>
      </div>
      {areaSqft > 0 && (
        <div className="text-sm">Area: {areaSqft.toLocaleString()} sq ft</div>
      )}
      {savedArea && (
        <div className="text-sm text-green-600">
          Saved — {savedArea.toLocaleString()} sq ft
        </div>
      )}
      {!savedArea && initial?.measured_sqft && (
        <div className="text-sm text-green-600">
          Saved: {initial.measured_sqft.toLocaleString()} sq ft
        </div>
      )}
      {saveStatus.error && (
        <div className="text-sm text-red-600">{saveStatus.error}</div>
      )}
      {saveStatus.message && (
        <div className="text-sm text-green-600">{saveStatus.message}</div>
      )}
    </div>
  );
}
