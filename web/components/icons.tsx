// Dashboard icons: Hugeicons' free stroke-rounded set (MIT), as Town draws them (24 grid, stroke 2).
// One place maps the desk's names to Hugeicons, so call sites read like any icon component.
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  Analytics01Icon,
  ArrowDown01Icon,
  ArrowDown02Icon,
  ArrowExpandDiagonal01Icon,
  ArrowLeft01Icon,
  ArrowLeftDoubleIcon,
  ArrowRight01Icon,
  ArrowRight02Icon,
  ArrowRightDoubleIcon,
  ArrowUp01Icon,
  ArrowUp02Icon,
  BookOpen01Icon,
  BotIcon as HugeBotIcon,
  Bug01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  ComputerIcon,
  Delete02Icon,
  Download04Icon,
  Edit02Icon,
  File01Icon,
  FlashIcon as HugeFlashIcon,
  Globe02Icon,
  HelpCircleIcon,
  InformationCircleIcon,
  InboxIcon as HugeInboxIcon,
  Key01Icon,
  LayoutThreeColumnIcon,
  LinkSquare02Icon,
  Logout01Icon,
  Moon02Icon,
  MoreHorizontalIcon,
  Notification01Icon,
  PlusSignIcon,
  RefreshIcon as HugeRefreshIcon,
  Search01Icon,
  Settings02Icon,
  SidebarLeft01Icon,
  SourceCodeIcon,
  SparklesIcon,
  Sun03Icon,
  TextIcon as HugeTextIcon,
  Tick02Icon,
  Upload04Icon,
  UserMultipleIcon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps } from "react";

type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon">;

function make(icon: IconSvgElement) {
  return function Icon(props: IconProps) {
    return <HugeiconsIcon icon={icon} strokeWidth={2} aria-hidden="true" {...props} />;
  };
}

export const ArrowDownIcon = make(ArrowDown02Icon);
export const ArrowRightIcon = make(ArrowRight02Icon);
export const ArrowUpIcon = make(ArrowUp02Icon);
export const BookOpenIcon = make(BookOpen01Icon);
export const BotIcon = make(HugeBotIcon);
export const BugIcon = make(Bug01Icon);
export const ChatIcon = make(BubbleChatIcon);
export const CodeIcon = make(SourceCodeIcon);
export const ChartColumnIcon = make(Analytics01Icon);
export const CheckIcon = make(Tick02Icon);
export const ChevronLeftIcon = make(ArrowLeft01Icon);
export const ChevronsLeftIcon = make(ArrowLeftDoubleIcon);
export const ChevronsRightIcon = make(ArrowRightDoubleIcon);
export const ChevronDownIcon = make(ArrowDown01Icon);
export const ChevronRightIcon = make(ArrowRight01Icon);
export const ChevronUpIcon = make(ArrowUp01Icon);
export const ColumnsIcon = make(LayoutThreeColumnIcon);
export const DownloadIcon = make(Download04Icon);
export const EditIcon = make(Edit02Icon);
export const ExpandIcon = make(ArrowExpandDiagonal01Icon);
export const ExternalLinkIcon = make(LinkSquare02Icon);
export const FileIcon = make(File01Icon);
export const FlashIcon = make(HugeFlashIcon);
export const GlobeIcon = make(Globe02Icon);
export const HelpIcon = make(HelpCircleIcon);
export const InfoIcon = make(InformationCircleIcon);
export const InboxIcon = make(HugeInboxIcon);
export const KeyIcon = make(Key01Icon);
export const MoreIcon = make(MoreHorizontalIcon);
export const NotificationIcon = make(Notification01Icon);
export const MonitorIcon = make(ComputerIcon);
export const PlusIcon = make(PlusSignIcon);
export const MoonIcon = make(Moon02Icon);
export const RefreshIcon = make(HugeRefreshIcon);
export const SearchIcon = make(Search01Icon);
export const SettingsIcon = make(Settings02Icon);
export const SidebarIcon = make(SidebarLeft01Icon);
export const SignOutIcon = make(Logout01Icon);
export const SparkleIcon = make(SparklesIcon);
export const SunIcon = make(Sun03Icon);
export const TextIcon = make(HugeTextIcon);
export const ToolIcon = make(Wrench01Icon);
export const TrashIcon = make(Delete02Icon);
export const UploadIcon = make(Upload04Icon);
export const UsersIcon = make(UserMultipleIcon);
export const XIcon = make(Cancel01Icon);
