import { Box, Text } from "ink";
import React from "react";
import type { ArchiveEntry } from "./types.js";

const FLAVOR_COLOR: Record<string, Parameters<typeof Text>[0]["color"]> = {
  sandbox:    "yellow",
  staging:    "cyan",
  stage:      "cyan",
  production: "green",
};

function ArtifactRow({ label, present, size }: { label: string; present: boolean; size: string }) {
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={present ? "green" : "gray"}>{present ? "✅" : "—  "}</Text>
      <Text color={present ? "white" : "gray"}>{label.padEnd(28)}</Text>
      {present && <Text dimColor>{size} MB</Text>}
    </Box>
  );
}

interface Props {
  entry:              ArchiveEntry | null;
  focused:            boolean;
  notesScrollOff:     number;
  innerHeight:        number;
  onScrollOffChange:  (n: number) => void;
}

export function BuildDetail({ entry, focused, notesScrollOff, innerHeight, onScrollOffChange }: Props) {
  if (!entry) {
    return (
      <Box
        flexGrow={1}
        height={innerHeight + 2}
        borderStyle="round"
        borderColor="gray"
        alignItems="center"
        justifyContent="center"
      >
        <Text dimColor>Select a build</Text>
      </Box>
    );
  }

  const color = FLAVOR_COLOR[entry.flavor] ?? "white";
  const icons = [
    entry.platforms.includes("android") ? "🤖" : null,
    entry.platforms.includes("ios")     ? "🍎" : null,
  ].filter(Boolean).join(" ");

  // Fixed rows consumed above the notes section
  // header(1) + path(1) + divider(1) + artifacts-title(1) + 3 artifact rows + divider(1) + notes-title(1) = 10
  const FIXED_ROWS = 10;
  const notesAvailH = Math.max(2, innerHeight - FIXED_ROWS);

  const allNotes    = entry.releaseNotes ? entry.releaseNotes.split("\n") : ["(no release notes)"];
  const maxScroll   = Math.max(0, allNotes.length - notesAvailH);
  const clampedOff  = Math.min(notesScrollOff, maxScroll);
  const visibleNotes = allNotes.slice(clampedOff, clampedOff + notesAvailH);

  return (
    <Box
      flexGrow={1}
      flexDirection="column"
      height={innerHeight + 2}
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={2}
      paddingY={1}
    >
      {/* Header */}
      <Box flexDirection="row" gap={2}>
        <Text bold color="white">{entry.version}</Text>
        <Text bold color={color}>{entry.flavor}</Text>
        <Text>{icons}</Text>
        <Text dimColor>{entry.dateFormatted}</Text>
      </Box>

      {/* Path */}
      <Box overflow="hidden">
        <Text dimColor wrap="truncate">{"📁 "}{entry.dir}</Text>
      </Box>

      <Box overflow="hidden"><Text dimColor wrap="truncate">{"─".repeat(500)}</Text></Box>

      {/* Artifacts */}
      <Text bold color="cyan">Artifacts</Text>
      <ArtifactRow label="source.tar.gz"          present={entry.hasSource}      size={entry.sourceSizeMB} />
      <ArtifactRow label="androidsymbols.tar.gz" present={entry.androidSymbols} size={entry.androidSizeMB} />
      <ArtifactRow label="iossymbols.tar.gz"       present={entry.iosSymbols}     size={entry.iosSizeMB} />

      <Box overflow="hidden"><Text dimColor wrap="truncate">{"─".repeat(500)}</Text></Box>

      {/* Release notes */}
      <Box flexDirection="row" gap={2}>
        <Text bold color="cyan">Release Notes</Text>
        {allNotes.length > notesAvailH && (
          <Text dimColor>
            {clampedOff + 1}–{Math.min(clampedOff + notesAvailH, allNotes.length)} / {allNotes.length}
          </Text>
        )}
      </Box>

      {clampedOff > 0 && <Text dimColor>  ↑ scroll up for more</Text>}

      {visibleNotes.map((line, i) => (
        <Box key={i} overflow="hidden">
          <Text wrap="truncate">{line || " "}</Text>
        </Box>
      ))}

      {clampedOff < maxScroll && <Text dimColor>  ↓ scroll down for more</Text>}
    </Box>
  );
}
