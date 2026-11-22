import { MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";

const number = new Intl.NumberFormat();
const currency = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
});

export type TelemetryProps = {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsdMicros: number | null;
};

export function formatUsdMicros(micros: number): string {
  return currency.format(micros / 1_000_000);
}

export function TelemetryFacts({ inputTokens, outputTokens, costUsdMicros }: TelemetryProps) {
  return (
    <>
      {inputTokens !== null && (
        <MetadataListItem label="Input tokens">
          <Text as="span" type="inherit" color="inherit" data-telemetry-input-tokens="">
            {number.format(inputTokens)}
          </Text>
        </MetadataListItem>
      )}
      {outputTokens !== null && (
        <MetadataListItem label="Output tokens">
          <Text as="span" type="inherit" color="inherit" data-telemetry-output-tokens="">
            {number.format(outputTokens)}
          </Text>
        </MetadataListItem>
      )}
      {costUsdMicros !== null && (
        <MetadataListItem label="Reported cost">
          <Text as="span" type="inherit" color="inherit" data-telemetry-cost="">
            {formatUsdMicros(costUsdMicros)}
          </Text>
        </MetadataListItem>
      )}
    </>
  );
}

export function TelemetryInline({ inputTokens, outputTokens, costUsdMicros }: TelemetryProps) {
  if (inputTokens === null && outputTokens === null && costUsdMicros === null) return null;
  return (
    <Stack direction="horizontal" gap={2} wrap="wrap" data-telemetry-inline>
      {inputTokens !== null && (
        <Text type="inherit" color="inherit" data-telemetry-input-tokens>
          input tokens: {number.format(inputTokens)}
        </Text>
      )}
      {outputTokens !== null && (
        <Text type="inherit" color="inherit" data-telemetry-output-tokens>
          output tokens: {number.format(outputTokens)}
        </Text>
      )}
      {costUsdMicros !== null && (
        <Text type="inherit" color="inherit" data-telemetry-cost>
          cost: {formatUsdMicros(costUsdMicros)}
        </Text>
      )}
    </Stack>
  );
}
