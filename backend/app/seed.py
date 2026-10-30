"""Idempotent reference-data seed (categories and buildings).

Rows are inserted only if missing, so admin edits are never overwritten by a
restart. No user accounts are created here: the first administrator comes from
`python -m app.cli create-admin`, everyone else from the admin portal.
The building list is the starting campus layout; Team OSSC maintains it in the
admin portal.
"""

from sqlalchemy.dialects.postgresql import insert

from app.db import sessionmaker
from app.models.catalog import Building, Category

LEGACY_CATEGORIES = [
    ("carpentry", "C", "Carpentry", "बढ़ईगीरी", "ಬಡಗಿ ಕೆಲಸ",
     ["Chair", "Desk", "Door", "Window", "Cupboard", "Other"],
     ["कुर्सी", "मेज़", "दरवाज़ा", "खिड़की", "अलमारी", "अन्य"],
     ["ಕುರ್ಚಿ", "ಮೇಜು", "ಬಾಗಿಲು", "ಕಿಟಕಿ", "ಕಪಾಟು", "ಇತರ"]),
    ("plumbing", "P", "Plumbing", "प्लंबिंग", "ಪ್ಲಂಬಿಂಗ್",
     ["Tap", "Drain", "Leak", "Tank", "Other"],
     ["नल", "नाली", "रिसाव", "टंकी", "अन्य"],
     ["ನಲ್ಲ", "ಚರಂಡಿ", "ಸೋರಿಕೆ", "ಟ್ಯಾಂಕ್", "ಇತರ"]),
    ("internet", "I", "Internet", "इंटरनेट", "ಇಂಟರ್ನೆಟ್",
     ["Wi-Fi", "LAN port", "Router", "Other"],
     ["वाई-फ़ाई", "लैन पोर्ट", "राउटर", "अन्य"],
     ["ವೈ-ಫೈ", "ಲ್ಯಾನ್ ಪೋರ್ಟ್", "ರೌಟರ್", "ಇತರ"]),
    ("phone", "T", "Phone", "दूरभाष", "ದೂರವಾಣಿ",
     ["Extension", "Line", "Other"],
     ["एक्सटेंशन", "लाइन", "अन्य"],
     ["ವಿಸ್ತರಣೆ", "ಲೈನ್", "ಇತರ"]),
    ("projector", "R", "Projector", "प्रोजेक्टर", "ಪ್ರೊಜೆಕ್ಟರ್",
     ["Lamp", "Remote", "Screen", "HDMI", "Other"],
     ["लैंप", "रिमोट", "स्क्रीन", "एचडीएमआई", "अन्य"],
     ["ದೀಪ", "ರಿಮೋಟ್", "ಸ್ಕ್ರೀನ್", "ಎಚ್ಡಿಎಂಐ", "ಇತರ"]),
    ("flooring", "F", "Flooring", "फर्श", "ನೆಲಹಾಸು",
     ["Tile", "Crack", "Other"],
     ["टाइल", "दरार", "अन्य"],
     ["ಟೈಲ್", "ಬಿರುಕು", "ಇತರ"]),
    ("toilets", "W", "Toilets", "शौचालय", "ಶೌಚಾಲಯಗಳು",
     ["Flush", "Tap", "Blockage", "Other"],
     ["फ्लश", "नल", "रुकावट", "अन्य"],
     ["ಫ್ಲಶ್", "ನಲ್ಲ", "ಕಟ್ಟು", "ಇತರ"]),
    ("electrical", "E", "Electrical", "विद्युत", "ವಿದ್ಯುತ್",
     ["Fan", "Light", "Socket", "Switchboard", "Other"],
     ["पंखा", "लाइट", "सॉकेट", "स्विचबोर्ड", "अन्य"],
     ["ಫ್ಯಾನ್", "ದೀಪ", "ಸಾಕೆಟ್", "ಸ್ವಿಚ್ಬೋರ್ಡ್", "ಇತರ"]),
    ("other", "O", "Other", "अन्य", "ಇತರ", ["Other"], ["अन्य"], ["ಇತರ"]),
]

# Starting campus layout for Don Bosco Institute of Technology, Kumbalagodu,
# Mysuru Road, Bengaluru 560074 (dbit.edu.in). DBIT publishes its departments
# and facilities but not a building/room register, so these places follow the
# departments and facilities and their floors are provisional. Facilities
# confirms the real list in the admin portal before the pilot (plan 2.1).
LEGACY_BUILDINGS = [
    ("ADMIN", "Main Block (Administration)", "मुख्य भवन (प्रशासन)", "ಮುಖ್ಯ ಕಟ್ಟಡ (ಆಡಳಿತ)", ["Ground", "1", "2", "3"]),
    ("CSE", "Computer Science & Engineering", "कंप्यूटर साइंस एवं इंजीनियरिंग", "ಕಂಪ್ಯೂಟರ್ ಸೈನ್ಸ್ ಮತ್ತು ಎಂಜಿನಿಯರಿಂಗ್", ["Ground", "1", "2", "3"]),
    ("ISE", "Information Science & Engineering", "इन्फ़ॉर्मेशन साइंस एवं इंजीनियरिंग", "ಇನ್ಫರ್ಮೇಶನ್ ಸೈನ್ಸ್ ಮತ್ತು ಎಂಜಿನಿಯರಿಂಗ್", ["Ground", "1", "2", "3"]),
    ("ECE", "Electronics & Communication", "इलेक्ट्रॉनिक्स एवं कम्युनिकेशन", "ಎಲೆಕ್ಟ್ರಾನಿಕ್ಸ್ ಮತ್ತು ಕಮ್ಯುನಿಕೇಶನ್", ["Ground", "1", "2", "3"]),
    ("EEE", "Electrical & Electronics", "इलेक्ट्रिकल एवं इलेक्ट्रॉनिक्स", "ಎಲೆಕ್ಟ್ರಿಕಲ್ ಮತ್ತು ಎಲೆಕ್ಟ್ರಾನಿಕ್ಸ್", ["Ground", "1", "2"]),
    ("AI", "AI & ML / AI & Data Science", "एआई एवं एमएल / एआई एवं डेटा साइंस", "ಎಐ ಮತ್ತು ಎಂಎಲ್ / ಎಐ ಮತ್ತು ಡೇಟಾ ಸೈನ್ಸ್", ["Ground", "1", "2", "3"]),
    ("MECH", "Mechanical Engineering & Workshops", "मैकेनिकल इंजीनियरिंग एवं वर्कशॉप", "ಮೆಕ್ಯಾನಿಕಲ್ ಎಂಜಿನಿಯರಿಂಗ್ ಮತ್ತು ವರ್ಕ್ಶಾಪ್ಗಳು", ["Ground", "1", "2"]),
    ("CIVIL", "Civil Engineering", "सिविल इंजीनियरिंग", "ಸಿವಿಲ್ ಎಂಜಿನಿಯರಿಂಗ್", ["Ground", "1", "2"]),
    ("BSH", "Basic Sciences (Physics, Chemistry, Maths)", "मूल विज्ञान (भौतिकी, रसायन, गणित)", "ಮೂಲ ವಿಜ್ಞಾನ (ಭೌತಶಾಸ್ತ್ರ, ರಸಾಯನಶಾಸ್ತ್ರ, ಗಣಿತ)", ["Ground", "1", "2"]),
    ("MBA", "MBA Department", "एमबीए विभाग", "ಎಂಬಿಎ ವಿಭಾಗ", ["Ground", "1", "2"]),
    ("LIB", "Library and Information Centre", "पुस्तकालय एवं सूचना केंद्र", "ಗ್ರಂಥಾಲಯ ಮತ್ತು ಮಾಹಿತಿ ಕೇಂದ್ರ", ["Ground", "1"]),
    ("AUD", "Auditorium and Seminar Halls", "सभागार एवं सेमिनार हॉल", "ಸಭಾಂಗಣ ಮತ್ತು ಸೆಮಿನಾರ್ ಹಾಲ್ಗಳು", ["Ground", "1"]),
    ("FOOD", "Food Court", "फ़ूड कोर्ट", "ಫುಡ್ ಕೋರ್ಟ್", ["Ground"]),
    ("HOSTEL", "Hostel", "छात्रावास", "ಹಾಸ್ಟೆಲ್", ["Ground", "1", "2", "3"]),
    ("SPORTS", "Physical Education and Sports", "शारीरिक शिक्षा एवं खेल", "ದೈಹಿಕ ಶಿಕ್ಷಣ ಮತ್ತು ಕ್ರೀಡೆ", ["Ground"]),
    ("TRANS", "Transport and Parking", "परिवहन एवं पार्किंग", "ಸಾರಿಗೆ ಮತ್ತು ಪಾರ್ಕಿಂಗ್", ["Ground"]),
]


CATEGORIES = [
    ("it_services", "S", "IT Services", "आईटी सेवाएँ", "ಐಟಿ ಸೇವೆಗಳು", [
        "Computer / Laptop", "Wi-Fi / Internet", "Projector", "Printer / Scanner",
        "Smart Board / Display", "Software / Login Issue", "Network / LAN", "Other IT Issue",
    ], [
        "कंप्यूटर / लैपटॉप", "वाई-फ़ाई / इंटरनेट", "प्रोजेक्टर", "प्रिंटर / स्कैनर",
        "स्मार्ट बोर्ड / डिस्प्ले", "सॉफ़्टवेयर / लॉगिन समस्या", "नेटवर्क / लैन", "अन्य आईटी समस्या",
    ], [
        "ಕಂಪ್ಯೂಟರ್ / ಲ್ಯಾಪ್ಟಾಪ್", "ವೈ-ಫೈ / ಇಂಟರ್ನೆಟ್", "ಪ್ರೊಜೆಕ್ಟರ್", "ಪ್ರಿಂಟರ್ / ಸ್ಕ್ಯಾನರ್",
        "ಸ್ಮಾರ್ಟ್ ಬೋರ್ಡ್ / ಡಿಸ್ಪ್ಲೇ", "ಸಾಫ್ಟ್ವೇರ್ / ಲಾಗಿನ್ ಸಮಸ್ಯೆ", "ನೆಟ್ವರ್ಕ್ / ಲ್ಯಾನ್", "ಇತರ ಐಟಿ ಸಮಸ್ಯೆ",
    ]),
    ("civil", "V", "Civil", "सिविल", "ಸಿವಿಲ್", [
        "Desk / Chair / Furniture", "Door / Window / Lock", "Wall / Ceiling / Floor",
        "Plumbing / Water Leak", "Toilet / Washroom", "Roof / Waterproofing", "Other Civil Issue",
    ], [
        "डेस्क / कुर्सी / फर्नीचर", "दरवाज़ा / खिड़की / ताला", "दीवार / छत / फर्श",
        "प्लंबिंग / पानी का रिसाव", "शौचालय / वॉशरूम", "छत / जलरोधक", "अन्य सिविल समस्या",
    ], [
        "ಡೆಸ್ಕ್ / ಕುರ್ಚಿ / ಪೀಠೋಪಕರಣ", "ಬಾಗಿಲು / ಕಿಟಕಿ / ಬೀಗ", "ಗೋಡೆ / ಚಾವಣಿ / ನೆಲ",
        "ಪ್ಲಂಬಿಂಗ್ / ನೀರಿನ ಸೋರಿಕೆ", "ಶೌಚಾಲಯ / ವಾಶ್ರೂಮ್", "ಛಾವಣಿ / ಜಲನಿರೋಧಕ", "ಇತರ ಸಿವಿಲ್ ಸಮಸ್ಯೆ",
    ]),
    ("mechanical", "M", "Mechanical", "यांत्रिक", "ಯಾಂತ್ರಿಕ", [
        "Fan / Light / Electrical", "AC / Cooling", "Lab Equipment", "Machine / Tool",
        "Other Mechanical Issue",
    ], [
        "पंखा / लाइट / विद्युत", "एसी / कूलिंग", "लैब उपकरण", "मशीन / उपकरण",
        "अन्य यांत्रिक समस्या",
    ], [
        "ಫ್ಯಾನ್ / ದೀಪ / ವಿದ್ಯುತ್", "ಎಸಿ / ತಂಪಾಗಿಸುವಿಕೆ", "ಪ್ರಯೋಗಾಲಯ ಸಾಧನ", "ಯಂತ್ರ / ಉಪಕರಣ",
        "ಇತರ ಯಾಂತ್ರಿಕ ಸಮಸ್ಯೆ",
    ]),
]

ADMIN_AREAS = [
    "Principal's Office", "Administration Office", "Faculty Rooms", "Conference Room", "Other Area",
]
ADMIN_AREAS_KN = [
    "ಪ್ರಾಂಶುಪಾಲರ ಕಚೇರಿ", "ಆಡಳಿತ ಕಚೇರಿ", "ಅಧ್ಯಾಪಕರ ಕೊಠಡಿಗಳು", "ಸಮ್ಮೇಳನ ಕೊಠಡಿ", "ಇತರ ಪ್ರದೇಶ",
]

BLOCK_A_DEPARTMENTS = [
    "Computer Science and Engineering (CSE)",
    "Information Science and Engineering (ISE)",
    "Electronics and Communication Engineering (ECE)",
    "Physics",
    "Chemistry",
]
BLOCK_A_DEPARTMENTS_KN = [
    "ಕಂಪ್ಯೂಟರ್ ಸೈನ್ಸ್ ಮತ್ತು ಎಂಜಿನಿಯರಿಂಗ್ (ಸಿಎಸ್ಇ)",
    "ಇನ್ಫರ್ಮೇಶನ್ ಸೈನ್ಸ್ ಮತ್ತು ಎಂಜಿನಿಯರಿಂಗ್ (ಐಎಸ್ಇ)",
    "ಎಲೆಕ್ಟ್ರಾನಿಕ್ಸ್ ಮತ್ತು ಕಮ್ಯುನಿಕೇಶನ್ ಎಂಜಿನಿಯರಿಂಗ್ (ಇಸಿಇ)",
    "ಭೌತಶಾಸ್ತ್ರ",
    "ರಸಾಯನಶಾಸ್ತ್ರ",
]

BLOCK_B_DEPARTMENTS = [
    "Artificial Intelligence and Machine Learning (AI/ML)",
    "Artificial Intelligence and Data Science (AI&DS)",
    "Electrical and Electronics Engineering (EEE)",
    "Cybersecurity and IoT",
]
BLOCK_B_DEPARTMENTS_KN = [
    "ಕೃತಕ ಬುದ್ಧಿಮತ್ತೆ ಮತ್ತು ಯಂತ್ರ ಕಲಿಕೆ (ಎಐ/ಎಂಎಲ್)",
    "ಕೃತಕ ಬುದ್ಧಿಮತ್ತೆ ಮತ್ತು ಡೇಟಾ ಸೈನ್ಸ್ (ಎಐ ಮತ್ತು ಡಿಎಸ್)",
    "ಎಲೆಕ್ಟ್ರಿಕಲ್ ಮತ್ತು ಎಲೆಕ್ಟ್ರಾನಿಕ್ಸ್ ಎಂಜಿನಿಯರಿಂಗ್ (ಇಇಇ)",
    "ಸೈಬರ್ ಭದ್ರತೆ ಮತ್ತು ಐಒಟಿ",
]

BUILDINGS = [
    ("BLOCK_A", "Block A", "ब्लॉक ए", "ಬ್ಲಾಕ್ ಎ", ["Ground", "1", "2", "3"],
     BLOCK_A_DEPARTMENTS, BLOCK_A_DEPARTMENTS_KN),
    ("BLOCK_B", "Block B", "ब्लॉक बी", "ಬ್ಲಾಕ್ ಬಿ", ["Ground", "1", "2", "3"],
     BLOCK_B_DEPARTMENTS, BLOCK_B_DEPARTMENTS_KN),
    ("MBA", "PG Block (MBA & Research)", "पीजी ब्लॉक (एमबीए और अनुसंधान)", "ಪಿಜಿ ಬ್ಲಾಕ್ (ಎಂಬಿಎ ಮತ್ತು ಸಂಶೋಧನೆ)",
     ["Ground", "1", "2"],
     ["MBA Department", "Research Area", "Other Area"],
     ["ಎಂಬಿಎ ವಿಭಾಗ", "ಸಂಶೋಧನಾ ವಿಭಾಗ", "ಇತರ ಪ್ರದೇಶ"]),
    ("PU", "PU Block", "पीयू ब्लॉक", "ಪಿಯು ಬ್ಲಾಕ್", ["Ground", "1", "2", "3"],
     ["PU Classrooms", "Laboratories", "Staff Room", "Office", "Other Area"],
     ["ಪಿಯು ತರಗತಿ ಕೊಠಡಿಗಳು", "ಪ್ರಯೋಗಾಲಯಗಳು", "ಸಿಬ್ಬಂದಿ ಕೊಠಡಿ", "ಕಚೇರಿ", "ಇತರ ಪ್ರದೇಶ"]),
    ("HOSTEL", "Hostel", "छात्रावास", "ಹಾಸ್ಟೆಲ್", ["Ground", "1", "2", "3"],
     ["Boys Hostel", "Girls Hostel"], ["ಬಾಲಕರ ಹಾಸ್ಟೆಲ್", "ಬಾಲಕಿಯರ ಹಾಸ್ಟೆಲ್"]),
    ("ADMIN_BLOCK", "Administrator Block", "प्रशासक ब्लॉक", "ಆಡಳಿತಾಧಿಕಾರಿ ಬ್ಲಾಕ್", ["Ground", "1", "2"],
     ADMIN_AREAS, ADMIN_AREAS_KN),
    ("SPORTS", "Sports Department", "खेल विभाग", "ಕ್ರೀಡಾ ವಿಭಾಗ", ["Ground"], [], []),
]


async def seed_catalogs(session) -> None:
    for i, (code, letter, en, hi, kn, sub_en, sub_hi, sub_kn) in enumerate(LEGACY_CATEGORIES):
        await session.execute(
            insert(Category)
            .values(code=code, letter=letter, name_en=en, name_hi=hi, name_kn=kn,
                    subtypes_en=sub_en, subtypes_hi=sub_hi, subtypes_kn=sub_kn,
                    active=False, sort_order=100 + i)
            .on_conflict_do_nothing(index_elements=["code"])
        )
    for i, (code, letter, en, hi, kn, sub_en, sub_hi, sub_kn) in enumerate(CATEGORIES):
        await session.execute(
            insert(Category)
            .values(code=code, letter=letter, name_en=en, name_hi=hi, name_kn=kn,
                    subtypes_en=sub_en, subtypes_hi=sub_hi, subtypes_kn=sub_kn,
                    active=True, sort_order=i)
            .on_conflict_do_nothing(index_elements=["code"])
        )
    active_codes = {row[0] for row in BUILDINGS}
    for i, (code, en, hi, kn, floors) in enumerate(LEGACY_BUILDINGS):
        if code in active_codes:
            continue
        await session.execute(
            insert(Building)
            .values(code=code, name_en=en, name_hi=hi, name_kn=kn, floors=floors, active=False, sort_order=100 + i)
            .on_conflict_do_nothing(index_elements=["code"])
        )
    for i, (code, en, hi, kn, floors, departments, departments_kn) in enumerate(BUILDINGS):
        await session.execute(
            insert(Building)
            .values(code=code, name_en=en, name_hi=hi, name_kn=kn, floors=floors,
                    departments=departments, departments_kn=departments_kn,
                    active=True, sort_order=i)
            .on_conflict_do_nothing(index_elements=["code"])
        )


async def seed_all() -> None:
    async with sessionmaker()() as session:
        await seed_catalogs(session)
        await session.commit()
