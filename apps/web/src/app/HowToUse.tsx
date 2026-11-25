'use client';

import { HEADER_COLORS } from '@svalmap/ui';
import { LastSeenMarker, MasterMarker, SANCTION_EDGE, SHADOW_EDGE, SpoofMarker, StarMarker, TriangleMarker, WarningMarker } from './LayerRow';

/** The "How to use" panel: what each part of the map shows, and what it cannot tell you. */
export default function HowToUse() {
  return (
    <div className="guide">
      <p>
        NorthWatch puts live ships, sanctions and shadow-fleet lists, warnings and seabed
        infrastructure for the Norwegian Sea, the Barents Sea and Svalbard on one map. Everything
        comes from open sources, and every list match links back to its source.
      </p>

      <h3>Ships on the map</h3>
      <p>
        Inside the Norwegian and Jan Mayen zones and the Svalbard zone you see all registered
        ships. Further out and in the Baltic you only see Russian, sanctioned, shadow-fleet,
        research and military ships, and ships with signs of AIS spoofing. Russian research ships
        are followed anywhere in the world. Finnish coastal stations (Fintraffic's Digitraffic) add
        the Gulf of Finland, with the Russian oil ports, and the Gulf of Bothnia. Colour shows the
        flag; zoomed in, the triangle points where the ship is heading.
      </p>
      <ul className="guide-keys">
        <li>
          <WarningMarker edge={SANCTION_EDGE} /> On a sanctions list (EU, US, UK, Canada, …)
        </li>
        <li>
          <WarningMarker edge={SHADOW_EDGE} /> Shadow fleet (Ukraine GUR)
        </li>
        <li>
          <MasterMarker /> The master is on GUR's sanctioned-captains list
        </li>
        <li>
          <SpoofMarker /> Possible AIS spoofing
        </li>
        <li>
          <LastSeenMarker /> Russian research ship's last known position, from Global Fishing Watch.
          Not live: it can be weeks old, and the label shows the date
        </li>
        <li>
          <StarMarker /> On your watchlist
        </li>
        <li>
          <TriangleMarker color={HEADER_COLORS.russia} /> Russian flag
        </li>
      </ul>
      <p>
        <b>Ships</b> filters what is shown: start from a quick view, or tick “Show only” for the
        groups you are after.
      </p>

      <h3>A ship's dossier</h3>
      <p>
        Click a ship (or search by name, MMSI or IMO). <b>Lists</b> tells you which list it is on,
        under which name and IMO, and whether the match is on IMO or only on MMSI. An MMSI-only
        match to a ship with another name is often a reused number. FleetLeaks, an independent
        tracker, is shown as corroboration, or as a hint when it lists a ship our lists don't
        (check the official list before relying on it). <b>Look up</b> opens the ship
        on VesselFinder, MarineTraffic, the sanctions lists and satellite images. Notes stay in
        this browser.
      </p>
      <p>
        <b>Possible AIS spoofing</b> is only raised on what no real ship can report: a course over
        360°, 40 knots or more for a cargo ship, tanker, fishing vessel or tug, positions that jump
        further than any ship can sail (back and forth, or to a new place it then keeps reporting
        from), or several ships reporting one spot at impossible speeds. That last one points to
        spoofed GPS: the ships are probably elsewhere, and <b>Activity</b> lists the spot. One
        stray position is not enough. The dossier lists what was seen and when.
      </p>
      <p>
        The <b>timeline</b> shows the last 24 hours: speed, position reports, gaps and Global
        Fishing Watch events. Hover or drag along it to see where the ship was; ▶ plays it back.
      </p>

      <h3>Activity</h3>
      <p>
        <b>Stopped, meeting or over cables</b> flags ships of interest stopped at sea or close to
        another ship, and any ship slower than 2 knots for 30 minutes within 500 m of a cable or
        pipeline. <b>Global Fishing Watch</b> adds 30 days of AIS gaps, loitering, encounters and
        port visits, and radar detections (they arrive about 5 days late).
      </p>
      <p>
        Open a radar detection with no AIS to see <b>who it could be</b>: ships that went dark and
        could have been there that day, with a link to Sentinel-1 radar for the same place and
        day. An AIS gap shows the radar detections its ship could have been.
      </p>

      <h3>Sea, infrastructure and warnings</h3>
      <p>
        <b>Sea &amp; seabed</b>: seabed relief (the Norwegian Mapping Authority's 50 to 5 m model
        near Norway), depth
        contours, zones and the ice edge, plus satellite images of the area you are looking at.{' '}
        <b>Infrastructure</b>: telecom and power cables, pipelines, platforms and ports; the
        sea-chart layers appear as you zoom in. <b>Warnings</b>: navigational warnings in force,
        with areas drawn from the positions in the text, and <b>GPS interference</b> from GPSJam:
        where aircraft reported poor GPS the last full day, a sign of jamming or spoofing that
        also hits ships.
      </p>

      <h3>Alerts and sharing</h3>
      <p>
        <b>Alerts</b> (bottom left) watches an area you draw (click the corners and close it on
        the first one) for chosen ships or any ship. <b>Share</b> copies a link with your ship
        filters, the selected ship and its track range.
      </p>

      <h3>Read with care</h3>
      <ul>
        <li>AIS is reported by the ship itself and can be switched off or faked.</li>
        <li>No ship on the map is not the same as no ship at sea.</li>
        <li>Flags and leads here are starting points; check the source before relying on them.</li>
        <li>
          Some sources (Global Fishing Watch, OpenSanctions, TeleGeography) are for non-commercial
          use only.
        </li>
      </ul>
    </div>
  );
}
