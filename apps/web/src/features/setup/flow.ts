import {
  ClipboardCheck,
  DoorOpen,
  IdCard,
  Scissors,
  SlidersHorizontal,
  Store,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import type { TranslationKey } from '@/i18n';

/**
 * 开店向导的七个领域。步骤 id 与后端 `SETUP_STEP_IDS`
 * （`packages/contracts/src/setupReadiness.ts`）逐一对应，完成度一律由
 * 后端 `GET /v1/desk/setup/readiness` 推导，这里不再自己算。
 *
 * ⚠️ 标题 / 简称 / 描述一律走 i18n key，绝不写死中文 —— 写死过一次，
 * 五种语言下顶栏都显示中文，且类型检查抓不到（见 i18n/setup.ts 注释）。
 */
export type SetupStepId =
  | 'store'
  | 'directory'
  | 'rooms'
  | 'catalog'
  | 'team'
  | 'features'
  | 'launch';

export interface SetupStep {
  id: SetupStepId;
  number: number;
  icon: LucideIcon;
  titleKey: TranslationKey;
  shortTitleKey: TranslationKey;
  descriptionKey: TranslationKey;
  /** 是否是开店硬门槛。false 的步骤（员工基础设置、功能设置）关着也能开店。 */
  blocksLaunch: boolean;
}

export const SETUP_STEPS: SetupStep[] = [
  {
    id: 'store',
    number: 1,
    icon: Store,
    titleKey: 'setupStepStoreTitle',
    shortTitleKey: 'setupStepStoreShort',
    descriptionKey: 'setupStepStoreDesc',
    blocksLaunch: true,
  },
  {
    id: 'directory',
    number: 2,
    icon: IdCard,
    titleKey: 'setupStepDirectoryTitle',
    shortTitleKey: 'setupStepDirectoryShort',
    descriptionKey: 'setupStepDirectoryDesc',
    blocksLaunch: false,
  },
  {
    id: 'rooms',
    number: 3,
    icon: DoorOpen,
    titleKey: 'setupStepRoomsTitle',
    shortTitleKey: 'setupStepRoomsShort',
    descriptionKey: 'setupStepRoomsDesc',
    blocksLaunch: true,
  },
  {
    id: 'catalog',
    number: 4,
    icon: Scissors,
    titleKey: 'setupStepCatalogTitle',
    shortTitleKey: 'setupStepCatalogShort',
    descriptionKey: 'setupStepCatalogDesc',
    blocksLaunch: true,
  },
  {
    id: 'team',
    number: 5,
    icon: UsersRound,
    titleKey: 'setupStepTeamTitle',
    shortTitleKey: 'setupStepTeamShort',
    descriptionKey: 'setupStepTeamDesc',
    blocksLaunch: true,
  },
  {
    id: 'features',
    number: 6,
    icon: SlidersHorizontal,
    titleKey: 'setupStepFeaturesTitle',
    shortTitleKey: 'setupStepFeaturesShort',
    descriptionKey: 'setupStepFeaturesDesc',
    blocksLaunch: false,
  },
  {
    id: 'launch',
    number: 7,
    icon: ClipboardCheck,
    titleKey: 'setupStepLaunchTitle',
    shortTitleKey: 'setupStepLaunchShort',
    descriptionKey: 'setupStepLaunchDesc',
    blocksLaunch: true,
  },
];

export const SETUP_STEP_IDS = SETUP_STEPS.map((step) => step.id);

/** 开店硬门槛步骤（对应后端会给出 `missing` 的领域 + launch 自身）。 */
export const LAUNCH_BLOCKING_STEP_IDS = SETUP_STEPS
  .filter((step) => step.blocksLaunch)
  .map((step) => step.id);
