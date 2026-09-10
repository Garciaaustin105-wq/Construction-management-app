/** SADP and WS-Discovery response parsing, against realistic fixtures.
 *  The failure feared: a field the parser silently drops, so a camera onboards
 *  with no serial and its identity degrades to MAC-only without anyone noticing. */
import { parseSadpResponse } from "../agent/sadp.mjs";
import { parseXAddrs, parseScopes } from "../agent/wsdiscovery.mjs";
import { normaliseMac, vendorFromMac } from "../dist/camera.js";
import { check, eq, report } from "./_assert.mjs";

console.log("discovery parsers");

const SADP_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<ProbeMatch>
<Uuid>4C4B6F3A-0000-0000-0000-000000000000</Uuid>
<Types>inquiry</Types>
<DeviceType>DS-2CD2086G2-I</DeviceType>
<DeviceDescription>IPCamera</DeviceDescription>
<DeviceSN>DS-2CD2086G2-I20210101AAWR123456789</DeviceSN>
<CommandPort>8000</CommandPort>
<HttpPort>80</HttpPort>
<MAC>44-19-b6-aa-bb-cc</MAC>
<IPv4Address>192.168.1.64</IPv4Address>
<IPv4Gateway>192.168.1.1</IPv4Gateway>
<SoftwareVersion>V5.7.3build 210706</SoftwareVersion>
<BootTime>2026-09-01 08:00:00</BootTime>
<Activated>true</Activated>
</ProbeMatch>`;

check("SADP yields the fields camera identity needs", () => {
  const d = parseSadpResponse(SADP_FIXTURE);
  eq(d.ip, "192.168.1.64", "ip");
  eq(d.mac, "44-19-b6-aa-bb-cc", "mac, raw form");
  eq(d.serial, "DS-2CD2086G2-I20210101AAWR123456789", "serial");
  eq(d.firmware, "V5.7.3build 210706", "firmware");
  eq(d.activated, "true", "activated");
});

check("the SADP MAC normalises and identifies the vendor", () => {
  const d = parseSadpResponse(SADP_FIXTURE);
  eq(normaliseMac(d.mac), "44:19:b6:aa:bb:cc", "normalised");
  eq(vendorFromMac(d.mac), "hikvision", "vendor from OUI");
});

check("firmware v5.7.3 is past v5.5.0 — ONVIF is off by default, SADP still answered", () => {
  const d = parseSadpResponse(SADP_FIXTURE);
  const [major, minor] = d.firmware.replace(/^V/, "").split(".").map(Number);
  if (!(major > 5 || (major === 5 && minor >= 5))) {
    throw new Error("fixture no longer exercises the ONVIF-disabled case");
  }
});

check("DeviceDescription is preferred, DeviceType is the fallback", () => {
  eq(parseSadpResponse(SADP_FIXTURE).model, "IPCamera", "description wins");
  const noDesc = SADP_FIXTURE.replace(/<DeviceDescription>[^<]*<\/DeviceDescription>/, "");
  eq(parseSadpResponse(noDesc).model, "DS-2CD2086G2-I", "falls back to type");
});

check("a response with neither MAC nor IP is rejected, not half-parsed", () => {
  eq(parseSadpResponse("<ProbeMatch><Types>inquiry</Types></ProbeMatch>"), null, "null");
  eq(parseSadpResponse("garbage"), null, "null");
});

check("a partial response still yields what it has, nulls for the rest", () => {
  const d = parseSadpResponse("<ProbeMatch><IPv4Address>10.0.0.9</IPv4Address></ProbeMatch>");
  eq(d.ip, "10.0.0.9", "ip");
  eq(d.mac, null, "mac null, not empty string");
  eq(d.serial, null, "serial null");
});

const WSD_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope">
<SOAP-ENV:Body><d:ProbeMatches xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<d:ProbeMatch>
<d:Scopes>onvif://www.onvif.org/name/Corridor_B onvif://www.onvif.org/hardware/DS-2CD2086G2-I onvif://www.onvif.org/location/Building_2</d:Scopes>
<d:XAddrs>http://192.168.1.64/onvif/device_service http://[fe80::1]/onvif/device_service</d:XAddrs>
</d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

check("WS-Discovery yields every service address", () => {
  const addrs = parseXAddrs(WSD_FIXTURE);
  eq(addrs.length, 2, "two addresses");
  eq(addrs[0], "http://192.168.1.64/onvif/device_service", "first");
});

check("ONVIF scopes decode into name, hardware and location", () => {
  const scopes = parseScopes(WSD_FIXTURE);
  eq(scopes.name, "Corridor B", "underscores become spaces");
  eq(scopes.hardware, "DS-2CD2086G2-I", "hardware");
  eq(scopes.location, "Building 2", "location");
});

check("a probe match with no XAddrs yields nothing, not a broken entry", () => {
  eq(parseXAddrs("<d:ProbeMatch></d:ProbeMatch>"), [], "empty");
  eq(parseScopes("<d:ProbeMatch></d:ProbeMatch>"), {}, "empty");
});

report("discovery parsers");
