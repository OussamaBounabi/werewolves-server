/** Imposter's secret words, by category: English | French | Arabic, one per line. */
const LISTS: Record<string, string> = {
  food: `
Pizza|Pizza|بيتزا
Burger|Burger|برغر
Couscous|Couscous|كسكس
Shawarma|Chawarma|شاورما
Sushi|Sushi|سوشي
Pasta|Pâtes|معكرونة
Soup|Soupe|حساء
Salad|Salade|سلطة
Sandwich|Sandwich|ساندويتش
French fries|Frites|بطاطا مقلية
Chocolate|Chocolat|شوكولاتة
Ice cream|Glace|آيس كريم
Cake|Gâteau|كعكة
Bread|Pain|خبز
Cheese|Fromage|جبن
Rice|Riz|أرز
Chicken|Poulet|دجاج
Fish|Poisson|سمك
Eggs|Œufs|بيض
Honey|Miel|عسل
Dates|Dattes|تمر
Apple|Pomme|تفاح
Banana|Banane|موز
Watermelon|Pastèque|بطيخ
Strawberry|Fraise|فراولة
Grapes|Raisin|عنب
Lemon|Citron|ليمون
Tomato|Tomate|طماطم
Carrot|Carotte|جزر
Olives|Olives|زيتون
Milk|Lait|حليب
Tea|Thé|شاي
Coffee|Café|قهوة
Croissant|Croissant|كرواسون
Pancakes|Crêpes|كريب
Popcorn|Pop-corn|فشار`,
  animals: `
Lion|Lion|أسد
Tiger|Tigre|نمر
Elephant|Éléphant|فيل
Giraffe|Girafe|زرافة
Monkey|Singe|قرد
Camel|Chameau|جمل
Horse|Cheval|حصان
Cow|Vache|بقرة
Sheep|Mouton|خروف
Goat|Chèvre|ماعز
Dog|Chien|كلب
Cat|Chat|قطة
Rabbit|Lapin|أرنب
Mouse|Souris|فأر
Bear|Ours|دب
Wolf|Loup|ذئب
Fox|Renard|ثعلب
Snake|Serpent|ثعبان
Crocodile|Crocodile|تمساح
Turtle|Tortue|سلحفاة
Frog|Grenouille|ضفدع
Eagle|Aigle|نسر
Owl|Hibou|بومة
Parrot|Perroquet|ببغاء
Penguin|Pingouin|بطريق
Dolphin|Dauphin|دلفين
Shark|Requin|قرش
Whale|Baleine|حوت
Octopus|Pieuvre|أخطبوط
Butterfly|Papillon|فراشة
Bee|Abeille|نحلة
Ant|Fourmi|نملة
Spider|Araignée|عنكبوت
Zebra|Zèbre|حمار وحشي
Kangaroo|Kangourou|كنغر
Panda|Panda|باندا`,
  places: `
Beach|Plage|شاطئ
Desert|Désert|صحراء
Mountain|Montagne|جبل
Forest|Forêt|غابة
School|École|مدرسة
Hospital|Hôpital|مستشفى
Airport|Aéroport|مطار
Train station|Gare|محطة قطار
Stadium|Stade|ملعب
Mosque|Mosquée|مسجد
Market|Marché|سوق
Supermarket|Supermarché|سوبرماركت
Restaurant|Restaurant|مطعم
Cinema|Cinéma|سينما
Library|Bibliothèque|مكتبة
Museum|Musée|متحف
Zoo|Zoo|حديقة الحيوانات
Park|Parc|حديقة عامة
Swimming pool|Piscine|مسبح
Gym|Salle de sport|قاعة رياضة
Bank|Banque|بنك
Pharmacy|Pharmacie|صيدلية
Police station|Commissariat|مركز شرطة
Hotel|Hôtel|فندق
Bakery|Boulangerie|مخبزة
Barbershop|Salon de coiffure|صالون حلاقة
Kitchen|Cuisine|مطبخ
Bedroom|Chambre|غرفة نوم
Office|Bureau|مكتب
Farm|Ferme|مزرعة
Island|Île|جزيرة
Castle|Château|قلعة
Prison|Prison|سجن
Amusement park|Parc d'attractions|مدينة ملاهي
Space|Espace|الفضاء
Wedding hall|Salle des fêtes|قاعة أفراح`,
  jobs: `
Doctor|Médecin|طبيب
Nurse|Infirmier|ممرض
Teacher|Professeur|أستاذ
Police officer|Policier|شرطي
Firefighter|Pompier|رجل إطفاء
Chef|Cuisinier|طباخ
Baker|Boulanger|خباز
Pilot|Pilote|طيار
Taxi driver|Chauffeur de taxi|سائق أجرة
Farmer|Agriculteur|فلاح
Fisherman|Pêcheur|صياد
Engineer|Ingénieur|مهندس
Mechanic|Mécanicien|ميكانيكي
Electrician|Électricien|كهربائي
Plumber|Plombier|سباك
Carpenter|Menuisier|نجار
Barber|Coiffeur|حلاق
Dentist|Dentiste|طبيب أسنان
Pharmacist|Pharmacien|صيدلي
Lawyer|Avocat|محامي
Judge|Juge|قاضي
Journalist|Journaliste|صحفي
Photographer|Photographe|مصور
Singer|Chanteur|مغني
Actor|Acteur|ممثل
Painter|Peintre|رسام
Footballer|Footballeur|لاعب كرة قدم
Astronaut|Astronaute|رائد فضاء
Soldier|Soldat|جندي
Programmer|Programmeur|مبرمج
Waiter|Serveur|نادل
Tailor|Tailleur|خياط
Postman|Facteur|ساعي البريد
Vet|Vétérinaire|طبيب بيطري
Architect|Architecte|مهندس معماري
Shopkeeper|Commerçant|تاجر`,
  sports: `
Football|Football|كرة القدم
Basketball|Basket-ball|كرة السلة
Tennis|Tennis|التنس
Volleyball|Volley-ball|الكرة الطائرة
Handball|Handball|كرة اليد
Swimming|Natation|السباحة
Running|Course à pied|الجري
Boxing|Boxe|الملاكمة
Karate|Karaté|الكاراتيه
Judo|Judo|الجودو
Wrestling|Lutte|المصارعة
Cycling|Cyclisme|ركوب الدراجات
Golf|Golf|الغولف
Skiing|Ski|التزلج على الثلج
Surfing|Surf|ركوب الأمواج
Horse riding|Équitation|ركوب الخيل
Gymnastics|Gymnastique|الجمباز
Weightlifting|Haltérophilie|رفع الأثقال
Table tennis|Tennis de table|تنس الطاولة
Badminton|Badminton|الريشة الطائرة
Baseball|Baseball|البيسبول
Rugby|Rugby|الرغبي
Ice hockey|Hockey sur glace|هوكي الجليد
Chess|Échecs|الشطرنج
Archery|Tir à l'arc|الرماية بالقوس
Fencing|Escrime|المبارزة
Climbing|Escalade|التسلق
Skateboarding|Skateboard|التزلج على اللوح
Bowling|Bowling|البولينغ
Billiards|Billard|البلياردو
Diving|Plongée|الغوص
Rowing|Aviron|التجديف
Marathon|Marathon|الماراثون
Formula 1|Formule 1|الفورمولا 1
Yoga|Yoga|اليوغا
Darts|Fléchettes|رمي السهام`,
  objects: `
Key|Clé|مفتاح
Lamp|Lampe|مصباح
Phone|Téléphone|هاتف
Watch|Montre|ساعة يد
Glasses|Lunettes|نظارة
Umbrella|Parapluie|مظلة
Chair|Chaise|كرسي
Table|Table|طاولة
Bed|Lit|سرير
Mirror|Miroir|مرآة
Clock|Horloge|ساعة حائط
Pencil|Crayon|قلم رصاص
Book|Livre|كتاب
Backpack|Sac à dos|حقيبة ظهر
Wallet|Portefeuille|محفظة
Scissors|Ciseaux|مقص
Hammer|Marteau|مطرقة
Candle|Bougie|شمعة
Pillow|Oreiller|وسادة
Toothbrush|Brosse à dents|فرشاة أسنان
Television|Télévision|تلفاز
Camera|Appareil photo|آلة تصوير
Guitar|Guitare|غيتار
Bottle|Bouteille|قارورة
Cup|Tasse|فنجان
Spoon|Cuillère|ملعقة
Knife|Couteau|سكين
Fork|Fourchette|شوكة
Soap|Savon|صابون
Towel|Serviette|منشفة
Shoes|Chaussures|حذاء
Hat|Chapeau|قبعة
Ring|Bague|خاتم
Remote control|Télécommande|جهاز التحكم
Computer|Ordinateur|حاسوب
Headphones|Casque audio|سماعات`,
  countries: `
Algeria|Algérie|الجزائر
Morocco|Maroc|المغرب
Tunisia|Tunisie|تونس
Egypt|Égypte|مصر
Saudi Arabia|Arabie saoudite|السعودية
Qatar|Qatar|قطر
United Arab Emirates|Émirats arabes unis|الإمارات
Palestine|Palestine|فلسطين
Lebanon|Liban|لبنان
Jordan|Jordanie|الأردن
Iraq|Irak|العراق
Syria|Syrie|سوريا
Turkey|Turquie|تركيا
France|France|فرنسا
Spain|Espagne|إسبانيا
Italy|Italie|إيطاليا
Germany|Allemagne|ألمانيا
England|Angleterre|إنجلترا
Portugal|Portugal|البرتغال
Netherlands|Pays-Bas|هولندا
Russia|Russie|روسيا
United States|États-Unis|الولايات المتحدة
Canada|Canada|كندا
Mexico|Mexique|المكسيك
Brazil|Brésil|البرازيل
Argentina|Argentine|الأرجنتين
China|Chine|الصين
Japan|Japon|اليابان
South Korea|Corée du Sud|كوريا الجنوبية
India|Inde|الهند
Australia|Australie|أستراليا
Senegal|Sénégal|السنغال
Nigeria|Nigeria|نيجيريا
South Africa|Afrique du Sud|جنوب أفريقيا
Greece|Grèce|اليونان
Switzerland|Suisse|سويسرا`,
  vehicles: `
Car|Voiture|سيارة
Bus|Bus|حافلة
Train|Train|قطار
Plane|Avion|طائرة
Helicopter|Hélicoptère|مروحية
Boat|Bateau|قارب
Ship|Navire|سفينة
Submarine|Sous-marin|غواصة
Bicycle|Vélo|دراجة هوائية
Motorcycle|Moto|دراجة نارية
Scooter|Trottinette|سكوتر
Truck|Camion|شاحنة
Taxi|Taxi|سيارة أجرة
Ambulance|Ambulance|سيارة إسعاف
Fire truck|Camion de pompiers|شاحنة إطفاء
Police car|Voiture de police|سيارة شرطة
Tractor|Tracteur|جرار
Rocket|Fusée|صاروخ
Tram|Tramway|ترامواي
Metro|Métro|مترو
Hot air balloon|Montgolfière|منطاد
Jet ski|Jet-ski|دراجة مائية
Sailboat|Voilier|مركب شراعي
Canoe|Canoë|زورق
Horse carriage|Calèche|عربة خيل
Cable car|Téléphérique|تلفريك
Limousine|Limousine|ليموزين
Jeep|Jeep|جيب
Van|Camionnette|شاحنة صغيرة
Excavator|Pelleteuse|حفارة
Race car|Voiture de course|سيارة سباق
Quad bike|Quad|دراجة رباعية
Yacht|Yacht|يخت
Drone|Drone|طائرة مسيرة
Bulldozer|Bulldozer|جرافة
Spaceship|Vaisseau spatial|مركبة فضائية`,
};

export type Word = { id: string; cat: string; en: string; fr: string; ar: string };

export const CATEGORIES = Object.keys(LISTS);

export const WORDS: Word[] = CATEGORIES.flatMap((cat) =>
  LISTS[cat]
    .trim()
    .split("\n")
    .map((line, i) => {
      const [en, fr, ar] = line.split("|").map((s) => s.trim());
      return { id: `${cat}-${i + 1}`, cat, en, fr, ar };
    }),
);

export const wordsOf = (cat: string) => WORDS.filter((w) => w.cat === cat);
