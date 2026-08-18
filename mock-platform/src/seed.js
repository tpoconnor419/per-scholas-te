// Fixture cohort for the mock platform. Deliberately messy: one learner is
// missing a sourcedid, one dropped, one has an ungraded final. Those are the
// cases that exercise the error and needs-review paths in the sync.

export const CONTEXT = {
  id: 'course-101',
  label: 'DEMO101',
  title: 'IT Support Cohort 24-A',
  type: ['CourseOffering'],
};

const LEARNER = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Learner';
const INSTRUCTOR = 'http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor';

export const MEMBERS = [
  {
    user_id: 'user-42',
    roles: [LEARNER],
    status: 'Active',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    lis_person_sourcedid: 'PS-24A-0001',
  },
  {
    user_id: 'user-43',
    roles: [LEARNER],
    status: 'Active',
    name: 'Grace Hopper',
    email: 'grace@example.com',
    lis_person_sourcedid: 'PS-24A-0002',
  },
  {
    user_id: 'user-44',
    roles: [LEARNER],
    status: 'Active',
    name: 'Katherine Johnson',
    email: 'katherine@example.com',
    lis_person_sourcedid: 'PS-24A-0003',
  },
  {
    user_id: 'user-45',
    roles: [LEARNER],
    status: 'Active',
    name: 'Mary Jackson',
    email: 'mary@example.com',
    // No sourcedid -- cannot be joined to the Airtable roster. This should
    // land in needs_review, not blow up the run.
  },
  {
    user_id: 'user-46',
    roles: [LEARNER],
    status: 'Inactive', // dropped; should be excluded from readiness entirely
    name: 'Dorothy Vaughan',
    email: 'dorothy@example.com',
    lis_person_sourcedid: 'PS-24A-0005',
  },
  {
    user_id: 'user-99',
    roles: [INSTRUCTOR],
    status: 'Active',
    name: 'Jean Bartik',
    email: 'jean@example.com',
  },
];

const base = 'http://localhost:4000/context/course-101/line_items';

export const LINE_ITEMS = [
  {
    id: `${base}/li-1`,
    label: 'Hardware Fundamentals Final',
    scoreMaximum: 100,
    tag: 'exam',
    resourceId: 'HW-FINAL',
  },
  {
    id: `${base}/li-2`,
    label: 'Networking Lab Practical',
    scoreMaximum: 50,
    tag: 'lab',
    resourceId: 'NET-LAB',
  },
  {
    id: `${base}/li-3`,
    label: 'Professional Skills Portfolio',
    scoreMaximum: 20,
    tag: 'portfolio',
    resourceId: 'PRO-PORT',
  },
  {
    id: `${base}/li-4`,
    label: 'Mock Certification Exam',
    scoreMaximum: 100,
    tag: 'exam',
    resourceId: 'MOCK-CERT',
  },
];

// Keyed by line item id suffix. Absent entry = not yet graded.
export const RESULTS = {
  'li-1': [
    { userId: 'user-42', resultScore: 94, resultMaximum: 100 },
    { userId: 'user-43', resultScore: 88, resultMaximum: 100 },
    { userId: 'user-44', resultScore: 71, resultMaximum: 100 },
    { userId: 'user-45', resultScore: 90, resultMaximum: 100 },
  ],
  'li-2': [
    { userId: 'user-42', resultScore: 47, resultMaximum: 50 },
    { userId: 'user-43', resultScore: 44, resultMaximum: 50 },
    { userId: 'user-44', resultScore: 38, resultMaximum: 50 },
    { userId: 'user-45', resultScore: 41, resultMaximum: 50 },
  ],
  'li-3': [
    { userId: 'user-42', resultScore: 20, resultMaximum: 20 },
    { userId: 'user-43', resultScore: 18, resultMaximum: 20 },
    // Katherine has not submitted the portfolio
    { userId: 'user-45', resultScore: 16, resultMaximum: 20 },
  ],
  'li-4': [
    { userId: 'user-42', resultScore: 91, resultMaximum: 100 },
    { userId: 'user-43', resultScore: 79, resultMaximum: 100 },
    { userId: 'user-44', resultScore: 82, resultMaximum: 100 },
    // Mary has not sat the mock exam
  ],
};
