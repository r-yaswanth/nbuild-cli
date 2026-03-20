import { Box, Text } from "ink";
import React from "react";

interface Props {
  focus: "list" | "detail";
}

function Key({ k, label }: { k: string; label: string }) {
  return (
    <Text dimColor>
      <Text color="cyan" bold>{k}</Text>
      {"  "}{label}
    </Text>
  );
}

export function StatusBar({ focus }: Props) {
  return (
    <Box paddingX={2} gap={4} borderStyle="round" borderColor="gray" marginX={1}>
      {focus === "list" ? (
        <>
          <Key k="↑↓ / scroll" label="navigate" />
          <Key k="Enter"       label="view details" />
          <Key k="Tab"         label="switch panel" />
          <Key k="o"           label="open in Finder" />
          <Key k="q"           label="quit" />
        </>
      ) : (
        <>
          <Key k="↑↓ / scroll" label="scroll notes" />
          <Key k="Tab"         label="back to list" />
          <Key k="o"           label="open in Finder" />
          <Key k="q"           label="quit" />
        </>
      )}
    </Box>
  );
}
