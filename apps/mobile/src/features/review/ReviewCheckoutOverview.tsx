import { LegendList } from "@legendapp/list/react-native";
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { ReviewDiffFileStat } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import type { ReviewCheckoutGroup } from "./reviewCheckouts";

type CheckoutOverviewRow =
  | { readonly id: string; readonly group: ReviewCheckoutGroup }
  | { readonly id: string; readonly file: ReviewDiffFileStat };

export function ReviewCheckoutOverview(props: {
  readonly groups: ReadonlyArray<ReviewCheckoutGroup>;
  readonly refreshing: boolean;
  readonly refresh: () => void;
  readonly open: (group: ReviewCheckoutGroup) => void;
  readonly topInset: number;
  readonly bottomInset: number;
}) {
  const gt = useGT();
  const rows = props.groups.flatMap((group): CheckoutOverviewRow[] => [
    { id: group.cwd, group },
    ...(group.section?.files ?? []).map((file) => ({
      id: JSON.stringify([group.cwd, file.path]),
      file,
    })),
  ]);
  return (
    <LegendList
      renderScrollComponent={NativeScrollView}
      data={rows}
      keyExtractor={(row) => row.id}
      estimatedItemSize={48}
      recycleItems
      contentInsetAdjustmentBehavior="never"
      contentContainerStyle={{ paddingTop: props.topInset, paddingBottom: props.bottomInset }}
      scrollIndicatorInsets={{ top: props.topInset, bottom: props.bottomInset }}
      refreshControl={<RefreshControl refreshing={props.refreshing} onRefresh={props.refresh} />}
      renderItem={({ item }) => {
        if ("file" in item) {
          const { file } = item;
          return (
            <View className="flex-row items-center gap-2 border-b border-border px-4 py-2">
              <Text className="min-w-0 flex-1 text-xs text-foreground-secondary">{file.path}</Text>
              <Text className="text-2xs font-t3-bold text-adaptive-emerald-700-300">
                +{formatDiffCount(file.additions)}
              </Text>
              <Text className="text-2xs font-t3-bold text-adaptive-rose-700-300">
                -{formatDiffCount(file.deletions)}
              </Text>
            </View>
          );
        }
        const { group } = item;
        const { section } = group;
        const hasDiff = Boolean(section?.diff || section?.files?.length);
        const detail =
          group.error ??
          (group.isPending && !section
            ? gt("Loading diff…")
            : hasDiff
              ? (section?.subtitle ?? gt("Open diff"))
              : gt("No changes"));
        return (
          <ListActionRow
            label={group.title}
            description={`${group.cwd}\n${detail}`}
            icon="chevron.right"
            disabled={!hasDiff}
            onPress={() => props.open(group)}
          />
        );
      }}
    />
  );
}
