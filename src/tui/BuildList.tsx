import { Box, Text } from "ink";
import React from "react";
import type { ArchiveEntry } from "./types.js";

const FLAVOR_COLOR: Record<string, Parameters<typeof Text>[0]["color"]> = {
  sandbox:    "yellow",
  staging:    "cyan",
  stage:      "cyan",
  production: "green",
};

function platformIcons(entry: ArchiveEntry): string {
  const parts: string[] = [];
  if (entry.platforms.includes("android")) parts.push("🤖");
  if (entry.platforms.includes("ios"))     parts.push("🍎");
  return parts.join(" ") || "—";
}

interface Props {
  entries:     ArchiveEntry[];
  selectedIdx: number;
  scrollOff:   number;
  focused:     boolean;
  innerHeight: number;
}

export function BuildList({ entries, selectedIdx, scrollOff, focused, innerHeight }: Props) {
  // Each entry renders as 2 rows; reserve 1 row for the "Builds" header
  const ITEM_H   = 2;
  const HEADER_H = 1;
  const maxVisible = Math.floor((innerHeight - HEADER_H) / ITEM_H);
  const visible    = entries.slice(scrollOff, scrollOff + maxVisible);
  const hasMore    = scrollOff + maxVisible < entries.length;

  return (
    <Box
      flexDirection="column"
      width={34}
      height={innerHeight + 2}
      borderStyle="round"
      borderColor={focused ? "cyan" : "gray"}
      paddingX={1}
      flexShrink={0}
    >
      <Text bold color="cyan">Builds</Text>

      {scrollOff > 0 && <Text dimColor>  ↑ {scrollOff} more</Text>}

      {entries.length === 0 && <Text dimColor>No archives found</Text>}

      {visible.map((entry, i) => {
        const absIdx    = scrollOff + i;
        const isSelected = absIdx === selectedIdx;
        const color      = FLAVOR_COLOR[entry.flavor] ?? "white";
        const icons      = platformIcons(entry);

        return (
          <Box key={entry.dir} flexDirection="column" marginBottom={0}>
            <Box flexDirection="row" gap={1}>
              <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? "▶" : " "}</Text>
              <Text bold={isSelected} color={isSelected ? "cyan" : color}>
                {entry.flavor.padEnd(10)}
              </Text>
              <Text dimColor={!isSelected}>{icons}</Text>
            </Box>
            <Box flexDirection="row" paddingLeft={2} gap={1}>
              <Text color={isSelected ? "white" : undefined} dimColor={!isSelected}>
                {entry.version}
              </Text>
              <Text dimColor>{entry.dateFormatted}</Text>
            </Box>
          </Box>
        );
      })}

      {hasMore && <Text dimColor>  ↓ {entries.length - scrollOff - maxVisible} more</Text>}
    </Box>
  );
}
