import { formatTimecode } from './timecode';
import { clipEndUs, type SnapshotClip } from './timeline-math';
import { Section, Segmented, type Choice } from './ui';

const SPEEDS = ['0.25', '0.5', '0.75', '1', '1.25', '1.5', '2', '3', '4'] as const;
type Speed = (typeof SPEEDS)[number];

const SPEED_CHOICES: readonly Choice<Speed>[] = SPEEDS.map((value) => ({
  value,
  label: `${value}×`,
  ...(value === '1' ? { title: 'Normal speed' } : {}),
}));

/** The selected clip: where it sits, and how fast it plays its recording. */
export function ClipPanel({
  clip,
  onSpeed,
}: {
  readonly clip: SnapshotClip;
  readonly onSpeed: (speed: number) => void;
}) {
  const current = SPEEDS.find((value) => Number(value) === clip.speed) ?? '1';
  return (
    <div className="inspector-body" data-testid="clip-panel">
      <Section
        title="Clip"
        aside={
          <span className="section-note">
            {formatTimecode(clip.timelineStartUs)} – {formatTimecode(clipEndUs(clip))}
          </span>
        }
      >
        <Segmented
          label="Speed"
          value={current}
          choices={SPEED_CHOICES}
          columns={5}
          onChange={(value) => onSpeed(Number(value))}
        />
        <p className="field-note">
          Faster clips take less time on the timeline; their sound keeps its pitch.
        </p>
      </Section>
    </div>
  );
}
