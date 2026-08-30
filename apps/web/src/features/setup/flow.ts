import {
  ClipboardCheck,
  Scissors,
  Store,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

export type SetupStepId =
  | 'store'
  | 'catalog'
  | 'team'
  | 'launch';

export interface SetupStep {
  id: SetupStepId;
  number: number;
  icon: LucideIcon;
  title: string;
  shortTitle: string;
  description: string;
  required: boolean;
}

/**
 * 开店向导只描述用户完成一家店所需的领域，不存“走到第几步”。
 * 真正进度后续应由门店、项目、员工等实际数据推导，避免跨设备出现假进度。
 */
export const SETUP_STEPS: SetupStep[] = [
  {
    id: 'store',
    number: 1,
    icon: Store,
    title: '确认门店资料',
    shortTitle: '门店资料',
    description: '确认店名、地址、电话、时区和营业时间。',
    required: true,
  },
  {
    id: 'catalog',
    number: 2,
    icon: Scissors,
    title: '设置项目与价格',
    shortTitle: '项目价格',
    description: '建立至少一个可售项目，先确认名称、价格和服务时长。',
    required: true,
  },
  {
    id: 'team',
    number: 3,
    icon: UsersRound,
    title: '添加员工与排班',
    shortTitle: '员工日程',
    description: '添加至少一位可接单员工；详细班表、技能和轮牌规则可在开店后完善。',
    required: true,
  },
  {
    id: 'launch',
    number: 4,
    icon: ClipboardCheck,
    title: '测试并正式开店',
    shortTitle: '测试开店',
    description: '确认开店检查项，通过后正式营业；测试预约和结账可在后台继续完成。',
    required: true,
  },
];

export const REQUIRED_SETUP_STEP_IDS = SETUP_STEPS
  .filter((step) => step.required)
  .map((step) => step.id);
