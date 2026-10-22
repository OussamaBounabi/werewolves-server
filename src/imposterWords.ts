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
Popcorn|Pop-corn|فشار
Hot dog|Hot-dog|هوت دوغ
Tacos|Tacos|تاكو
Kebab|Kebab|كباب
Falafel|Falafel|فلافل
Hummus|Houmous|حمص بالطحينة
Lasagna|Lasagnes|لازانيا
Spaghetti|Spaghettis|سباغيتي
Noodles|Nouilles|نودلز
Omelette|Omelette|عجة
Steak|Steak|شريحة لحم
Sausage|Saucisse|نقانق
Meatballs|Boulettes de viande|كرات اللحم
Tajine|Tajine|طاجين
Chorba|Chorba|شوربة جزائرية
Bourek|Bourek|بوراك
Baklava|Baklava|بقلاوة
Kunafa|Knafeh|كنافة
Donut|Beignet|دونات
Cookie|Cookie|كوكيز
Cupcake|Cupcake|كب كيك
Waffle|Gaufre|وافل
Candy|Bonbon|حلوى
Jam|Confiture|مربى
Butter|Beurre|زبدة
Yogurt|Yaourt|زبادي
Cereal|Céréales|حبوب الإفطار
Orange juice|Jus d'orange|عصير برتقال
Lemonade|Limonade|ليموناضة
Soda|Soda|مشروب غازي
Water|Eau|ماء
Hot chocolate|Chocolat chaud|شوكولاتة ساخنة
Milkshake|Milk-shake|ميلك شيك
Orange|Orange|برتقال
Mango|Mangue|مانجو
Pineapple|Ananas|أناناس
Peach|Pêche|خوخ
Pear|Poire|إجاص
Cherry|Cerise|كرز
Kiwi|Kiwi|كيوي
Pomegranate|Grenade|رمان
Fig|Figue|تين
Coconut|Noix de coco|جوز الهند
Avocado|Avocat|أفوكادو
Melon|Melon|شمام
Potato|Pomme de terre|بطاطا
Onion|Oignon|بصل
Garlic|Ail|ثوم
Cucumber|Concombre|خيار
Lettuce|Laitue|خس
Corn|Maïs|ذرة
Bell pepper|Poivron|فلفل حلو
Eggplant|Aubergine|باذنجان
Mushroom|Champignon|فطر
Pumpkin|Citrouille|يقطين
Peas|Petits pois|بازلاء
Lentils|Lentilles|عدس
Chickpeas|Pois chiches|حمص حب
Peanuts|Cacahuètes|فول سوداني
Almonds|Amandes|لوز
Salt|Sel|ملح
Sugar|Sucre|سكر
Ketchup|Ketchup|كاتشب
Mayonnaise|Mayonnaise|مايونيز
Shrimp|Crevette|جمبري`,
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
Panda|Panda|باندا
Gorilla|Gorille|غوريلا
Cheetah|Guépard|فهد
Leopard|Léopard|نمر مرقط
Hippopotamus|Hippopotame|فرس النهر
Rhinoceros|Rhinocéros|وحيد القرن
Polar bear|Ours polaire|دب قطبي
Koala|Koala|كوالا
Deer|Cerf|أيل
Gazelle|Gazelle|غزال
Donkey|Âne|حمار
Pig|Cochon|خنزير
Hen|Poule|دجاجة
Rooster|Coq|ديك
Duck|Canard|بطة
Goose|Oie|إوزة
Pigeon|Pigeon|حمامة
Ostrich|Autruche|نعامة
Flamingo|Flamant rose|فلامنغو
Peacock|Paon|طاووس
Swan|Cygne|بجعة
Bat|Chauve-souris|خفاش
Squirrel|Écureuil|سنجاب
Hedgehog|Hérisson|قنفذ
Hamster|Hamster|هامستر
Chameleon|Caméléon|حرباء
Lizard|Lézard|سحلية
Scorpion|Scorpion|عقرب
Crab|Crabe|سلطعون
Jellyfish|Méduse|قنديل البحر
Starfish|Étoile de mer|نجم البحر
Seahorse|Hippocampe|حصان البحر
Seal|Phoque|فقمة
Walrus|Morse|فظ
Lobster|Homard|كركند
Snail|Escargot|حلزون
Ladybug|Coccinelle|دعسوقة
Mosquito|Moustique|بعوضة
Fly|Mouche|ذبابة
Worm|Ver de terre|دودة
Dragonfly|Libellule|يعسوب
Hyena|Hyène|ضبع
Jaguar|Jaguar|جاكوار
Buffalo|Buffle|جاموس
Bull|Taureau|ثور
Llama|Lama|لاما
Raccoon|Raton laveur|راكون
Beaver|Castor|قندس
Otter|Loutre|ثعلب الماء
Sloth|Paresseux|كسلان
Porcupine|Porc-épic|نيص
Mole|Taupe|خلد
Moose|Élan|موظ
Falcon|Faucon|صقر
Vulture|Vautour|عقاب
Crow|Corbeau|غراب
Woodpecker|Pic|نقار الخشب
Hummingbird|Colibri|طائر الطنان
Seagull|Mouette|نورس
Toucan|Toucan|طوقان
Salmon|Saumon|سلمون
Goldfish|Poisson rouge|سمكة ذهبية
Squid|Calmar|حبار
Panther|Panthère noire|نمر أسود
Grasshopper|Sauterelle|جرادة`,
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
Wedding hall|Salle des fêtes|قاعة أفراح
Volcano|Volcan|بركان
Waterfall|Cascade|شلال
Lake|Lac|بحيرة
River|Rivière|نهر
Cave|Grotte|كهف
Jungle|Jungle|أدغال
Garden|Jardin|حديقة منزلية
Playground|Aire de jeux|ساحة ألعاب
University|Université|جامعة
Classroom|Salle de classe|قسم دراسي
Port|Port|ميناء
Gas station|Station-service|محطة بنزين
Fire station|Caserne de pompiers|مركز إطفاء
Post office|Bureau de poste|مكتب بريد
Shopping mall|Centre commercial|مركز تجاري
Café|Café|مقهى
Hammam|Hammam|حمام تقليدي
Bathroom|Salle de bain|دورة المياه
Living room|Salon|غرفة الجلوس
Garage|Garage|مرآب
Rooftop|Toit-terrasse|سطح
Balcony|Balcon|شرفة
Church|Église|كنيسة
Palace|Palais|قصر
Lighthouse|Phare|منارة
Bridge|Pont|جسر
Skyscraper|Gratte-ciel|ناطحة سحاب
Tower|Tour|برج
Pyramid|Pyramide|هرم
Bus station|Gare routière|محطة الحافلات
Parking lot|Parking|موقف سيارات
Factory|Usine|مصنع
Laboratory|Laboratoire|مختبر
Theater|Théâtre|مسرح
Circus|Cirque|سيرك
Aquarium|Aquarium|حوض أسماك
Bookstore|Librairie|متجر كتب
Butcher shop|Boucherie|ملحمة
Clothing store|Magasin de vêtements|متجر ملابس
Beauty salon|Salon de beauté|صالون تجميل
Laundry|Laverie|مغسلة ملابس
Car wash|Station de lavage|مغسلة سيارات
Embassy|Ambassade|سفارة
City hall|Mairie|البلدية
Court|Tribunal|محكمة
Cemetery|Cimetière|مقبرة
Village|Village|قرية
City|Ville|مدينة
Ski resort|Station de ski|منتجع تزلج
Campsite|Camping|مخيم
Oasis|Oasis|واحة
Valley|Vallée|وادي
Field|Champ|حقل
Tennis court|Court de tennis|ملعب تنس
Basement|Sous-sol|قبو
Stable|Écurie|إسطبل
Greenhouse|Serre|دفيئة
Bus stop|Arrêt de bus|موقف الحافلة
Water park|Parc aquatique|حديقة مائية
Highway|Autoroute|طريق سريع
Hill|Colline|تل
Cliff|Falaise|جرف
Swamp|Marais|مستنقع
Dentist's office|Cabinet dentaire|عيادة أسنان`,
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
Shopkeeper|Commerçant|تاجر
Butcher|Boucher|جزار
Hairdresser|Coiffeuse|مصففة شعر
Cashier|Caissier|أمين الصندوق
Accountant|Comptable|محاسب
Banker|Banquier|مصرفي
Secretary|Secrétaire|سكرتير
Translator|Traducteur|مترجم
Librarian|Bibliothécaire|أمين مكتبة
Scientist|Scientifique|عالم
Surgeon|Chirurgien|جراح
Paramedic|Ambulancier|مسعف
Midwife|Sage-femme|قابلة
Psychologist|Psychologue|طبيب نفسي
Professor|Professeur d'université|أستاذ جامعي
Student|Étudiant|طالب
Bus driver|Chauffeur de bus|سائق حافلة
Truck driver|Routier|سائق شاحنة
Delivery driver|Livreur|عامل توصيل
Flight attendant|Hôtesse de l'air|مضيفة طيران
Sailor|Marin|بحار
Captain|Capitaine|قبطان
Security guard|Agent de sécurité|حارس أمن
Detective|Détective|محقق
Spy|Espion|جاسوس
Gardener|Jardinier|بستاني
Builder|Maçon|بنّاء
Welder|Soudeur|لحام
Blacksmith|Forgeron|حداد
Shoemaker|Cordonnier|إسكافي
Jeweler|Bijoutier|صائغ
Florist|Fleuriste|بائع زهور
Cleaner|Agent d'entretien|عامل نظافة
Garbage collector|Éboueur|جامع القمامة
Fashion designer|Styliste|مصمم أزياء
Model|Mannequin|عارض أزياء
Dancer|Danseur|راقص
Musician|Musicien|موسيقي
Writer|Écrivain|كاتب
Poet|Poète|شاعر
Film director|Réalisateur|مخرج
Comedian|Humoriste|كوميدي
Magician|Magicien|ساحر
Clown|Clown|مهرج
YouTuber|YouTubeur|يوتيوبر
Referee|Arbitre|حكم
Coach|Entraîneur|مدرب
Lifeguard|Maître-nageur|منقذ
Tour guide|Guide touristique|مرشد سياحي
Real estate agent|Agent immobilier|وكيل عقاري
Imam|Imam|إمام
Mayor|Maire|رئيس البلدية
King|Roi|ملك
Ambassador|Ambassadeur|سفير
Miner|Mineur|عامل منجم
Shepherd|Berger|راعي غنم
Beekeeper|Apiculteur|نحال
Pastry chef|Pâtissier|حلواني
Train driver|Conducteur de train|سائق قطار
Optician|Opticien|أخصائي نظارات
Nanny|Nounou|مربية أطفال
Receptionist|Réceptionniste|موظف استقبال
Customs officer|Douanier|موظف جمارك
Archaeologist|Archéologue|عالم آثار
Graphic designer|Graphiste|مصمم غرافيك`,
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
Darts|Fléchettes|رمي السهام
Taekwondo|Taekwondo|تايكوندو
Kung fu|Kung-fu|كونغ فو
Sumo|Sumo|سومو
Kickboxing|Kick-boxing|كيك بوكسينغ
MMA|MMA|فنون القتال المختلطة
Beach volleyball|Beach-volley|الكرة الطائرة الشاطئية
Water polo|Water-polo|كرة الماء
Futsal|Futsal|كرة الصالات
Beach soccer|Football de plage|كرة القدم الشاطئية
American football|Football américain|كرة القدم الأمريكية
Cricket|Cricket|كريكت
Field hockey|Hockey sur gazon|هوكي الميدان
Squash|Squash|اسكواش
Padel|Padel|بادل
Snowboarding|Snowboard|التزلج على الثلج باللوح
Ice skating|Patinage|التزلج على الجليد
Figure skating|Patinage artistique|التزلج الفني
Bobsleigh|Bobsleigh|الزلاجة الجماعية
Sailing|Voile|الإبحار الشراعي
Kayaking|Kayak|التجديف بالكاياك
Water skiing|Ski nautique|التزلج على الماء
Kitesurfing|Kitesurf|التزلج بالطائرة الورقية
Fishing|Pêche|صيد السمك
Hunting|Chasse|الصيد البري
Parachuting|Parachutisme|القفز بالمظلة
Paragliding|Parapente|الطيران الشراعي
Bungee jumping|Saut à l'élastique|القفز بالحبل المطاطي
Hiking|Randonnée|المشي الجبلي
Motocross|Motocross|موتوكروس
Rally|Rallye|الرالي
Karting|Karting|كارتينغ
Horse racing|Course hippique|سباق الخيل
Camel racing|Course de chameaux|سباق الهجن
Polo|Polo|البولو
Triathlon|Triathlon|الترياتلون
High jump|Saut en hauteur|القفز العالي
Long jump|Saut en longueur|القفز الطويل
Pole vault|Saut à la perche|القفز بالزانة
Javelin|Lancer du javelot|رمي الرمح
Shot put|Lancer du poids|رمي الجلة
Discus|Lancer du disque|رمي القرص
Hurdles|Course de haies|سباق الحواجز
Relay race|Course de relais|سباق التتابع
Sprint|Sprint|العدو السريع
Race walking|Marche athlétique|المشي الرياضي
Bodybuilding|Culturisme|كمال الأجسام
Aerobics|Aérobic|الأيروبيك
Pilates|Pilates|البيلاتس
Breakdance|Breakdance|البريك دانس
Parkour|Parkour|الباركور
BMX|BMX|بي إم إكس
Roller skating|Roller|التزلج بالعجلات
Pétanque|Pétanque|الكرة الحديدية
Curling|Curling|الكيرلنغ
Rafting|Rafting|الرافتينغ
Mountain biking|VTT|الدراجات الجبلية
Shooting|Tir sportif|الرماية بالبندقية
Arm wrestling|Bras de fer|مصارعة الذراعين
Tug of war|Tir à la corde|شد الحبل
E-sports|E-sport|الرياضات الإلكترونية
Softball|Softball|السوفتبول
Lacrosse|Crosse|اللاكروس
Canoeing|Canoë|التجديف بالقارب
Motorcycle racing|Course de moto|سباق الدراجات النارية`,
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
Headphones|Casque audio|سماعات
Laptop|Ordinateur portable|حاسوب محمول
Tablet|Tablette|جهاز لوحي
Keyboard|Clavier|لوحة مفاتيح
Printer|Imprimante|طابعة
Charger|Chargeur|شاحن
Battery|Pile|بطارية
Light bulb|Ampoule|مصباح كهربائي
Flashlight|Lampe torche|مصباح يدوي
Fan|Ventilateur|مروحة
Air conditioner|Climatiseur|مكيف هواء
Refrigerator|Réfrigérateur|ثلاجة
Washing machine|Machine à laver|غسالة
Microwave|Micro-ondes|ميكروويف
Oven|Four|فرن
Kettle|Bouilloire|غلاية
Iron|Fer à repasser|مكواة
Vacuum cleaner|Aspirateur|مكنسة كهربائية
Broom|Balai|مكنسة
Bucket|Seau|دلو
Sofa|Canapé|أريكة
Carpet|Tapis|سجادة
Curtain|Rideau|ستارة
Blanket|Couverture|بطانية
Door|Porte|باب
Window|Fenêtre|نافذة
Plate|Assiette|صحن
Bowl|Bol|وعاء
Frying pan|Poêle|مقلاة
Pot|Casserole|قدر
Glass|Verre|كأس
Teapot|Théière|إبريق شاي
Comb|Peigne|مشط
Toothpaste|Dentifrice|معجون أسنان
Shampoo|Shampooing|شامبو
Perfume|Parfum|عطر
Hairdryer|Sèche-cheveux|مجفف شعر
Razor|Rasoir|موس حلاقة
Pen|Stylo|قلم
Eraser|Gomme|ممحاة
Ruler|Règle|مسطرة
Notebook|Cahier|دفتر
Calculator|Calculatrice|آلة حاسبة
Envelope|Enveloppe|ظرف
Stapler|Agrafeuse|دباسة
Screwdriver|Tournevis|مفك
Ladder|Échelle|سلم
Saw|Scie|منشار
Nail|Clou|مسمار
Rope|Corde|حبل
Padlock|Cadenas|قفل
Suitcase|Valise|حقيبة سفر
Sunglasses|Lunettes de soleil|نظارات شمسية
Necklace|Collier|قلادة
Bracelet|Bracelet|سوار
Belt|Ceinture|حزام
Gloves|Gants|قفازات
Scarf|Écharpe|وشاح
Teddy bear|Ours en peluche|دمية دب
Balloon|Ballon de baudruche|بالون
Kite|Cerf-volant|طائرة ورقية
Dice|Dé|نرد
Gift|Cadeau|هدية
Map|Carte|خريطة
Coin|Pièce de monnaie|قطعة نقدية`,
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
Switzerland|Suisse|سويسرا
Libya|Libye|ليبيا
Mauritania|Mauritanie|موريتانيا
Sudan|Soudan|السودان
Kuwait|Koweït|الكويت
Bahrain|Bahreïn|البحرين
Oman|Oman|عُمان
Yemen|Yémen|اليمن
Iran|Iran|إيران
Pakistan|Pakistan|باكستان
Afghanistan|Afghanistan|أفغانستان
Indonesia|Indonésie|إندونيسيا
Malaysia|Malaisie|ماليزيا
Thailand|Thaïlande|تايلاند
Vietnam|Viêt Nam|فيتنام
Philippines|Philippines|الفلبين
Singapore|Singapour|سنغافورة
Bangladesh|Bangladesh|بنغلاديش
North Korea|Corée du Nord|كوريا الشمالية
Mongolia|Mongolie|منغوليا
Kazakhstan|Kazakhstan|كازاخستان
Uzbekistan|Ouzbékistan|أوزبكستان
Belgium|Belgique|بلجيكا
Sweden|Suède|السويد
Norway|Norvège|النرويج
Denmark|Danemark|الدنمارك
Finland|Finlande|فنلندا
Iceland|Islande|آيسلندا
Ireland|Irlande|أيرلندا
Scotland|Écosse|اسكتلندا
Wales|Pays de Galles|ويلز
Austria|Autriche|النمسا
Poland|Pologne|بولندا
Ukraine|Ukraine|أوكرانيا
Croatia|Croatie|كرواتيا
Serbia|Serbie|صربيا
Romania|Roumanie|رومانيا
Hungary|Hongrie|المجر
Czech Republic|Tchéquie|التشيك
Bulgaria|Bulgarie|بلغاريا
Cyprus|Chypre|قبرص
Colombia|Colombie|كولومبيا
Chile|Chili|تشيلي
Peru|Pérou|بيرو
Uruguay|Uruguay|الأوروغواي
Venezuela|Venezuela|فنزويلا
Ecuador|Équateur|الإكوادور
Paraguay|Paraguay|باراغواي
Bolivia|Bolivie|بوليفيا
Cuba|Cuba|كوبا
Jamaica|Jamaïque|جامايكا
Ivory Coast|Côte d'Ivoire|ساحل العاج
Cameroon|Cameroun|الكاميرون
Ghana|Ghana|غانا
Mali|Mali|مالي
Kenya|Kenya|كينيا
Ethiopia|Éthiopie|إثيوبيا
Somalia|Somalie|الصومال
Tanzania|Tanzanie|تنزانيا
DR Congo|RD Congo|الكونغو الديمقراطية
Madagascar|Madagascar|مدغشقر
New Zealand|Nouvelle-Zélande|نيوزيلندا
Niger|Niger|النيجر
Chad|Tchad|تشاد
Burkina Faso|Burkina Faso|بوركينا فاسو`,
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
Spaceship|Vaisseau spatial|مركبة فضائية
School bus|Bus scolaire|حافلة مدرسية
Double-decker bus|Bus à impériale|حافلة بطابقين
Minibus|Minibus|حافلة صغيرة
Pickup truck|Pick-up|بيك آب
Garbage truck|Camion-poubelle|شاحنة نفايات
Tow truck|Dépanneuse|شاحنة سحب
Cement mixer|Bétonnière|خلاطة إسمنت
Tanker truck|Camion-citerne|شاحنة صهريج
Forklift|Chariot élévateur|رافعة شوكية
Crane|Grue|رافعة
Tank|Char|دبابة
Fighter jet|Avion de chasse|طائرة مقاتلة
Glider|Planeur|طائرة شراعية
Seaplane|Hydravion|طائرة مائية
Airship|Dirigeable|سفينة هوائية
Space shuttle|Navette spatiale|مكوك فضائي
Electric scooter|Trottinette électrique|سكوتر كهربائي
Skateboard|Skateboard|لوح تزلج
Roller skates|Rollers|أحذية بعجلات
Tricycle|Tricycle|دراجة ثلاثية
Unicycle|Monocycle|دراجة أحادية العجلة
Tandem bicycle|Tandem|دراجة ثنائية المقعد
Electric car|Voiture électrique|سيارة كهربائية
Convertible|Cabriolet|سيارة مكشوفة
Sports car|Voiture de sport|سيارة رياضية
Vintage car|Voiture ancienne|سيارة كلاسيكية
Camper van|Camping-car|عربة تخييم
Caravan|Caravane|كرفان
Rickshaw|Pousse-pousse|ريكشا
Tuk-tuk|Tuk-tuk|توك توك
Golf cart|Voiturette de golf|عربة غولف
Snowmobile|Motoneige|دراجة ثلجية
Sled|Luge|زلاجة
Go-kart|Kart|كارت
Monster truck|Monster truck|شاحنة عملاقة
Police motorcycle|Moto de police|دراجة شرطة
Ice cream truck|Camion de glaces|شاحنة المثلجات
Food truck|Food truck|شاحنة طعام
Steamroller|Rouleau compresseur|مدحلة
Combine harvester|Moissonneuse-batteuse|حصادة
Cargo ship|Cargo|سفينة شحن
Cruise ship|Paquebot|سفينة سياحية
Ferry|Ferry|عبّارة
Fishing boat|Bateau de pêche|قارب صيد
Speedboat|Hors-bord|قارب سريع
Kayak|Kayak|كاياك
Raft|Radeau|طوف
Gondola|Gondole|غوندولا
Pedal boat|Pédalo|قارب بدواسات
Lifeboat|Canot de sauvetage|قارب نجاة
Hovercraft|Aéroglisseur|حوامة
Aircraft carrier|Porte-avions|حاملة طائرات
Steam train|Train à vapeur|قطار بخاري
High-speed train|TGV|قطار فائق السرعة
Monorail|Monorail|قطار أحادي السكة
Funicular|Funiculaire|قطار جبلي مائل
Chairlift|Télésiège|تلفريك بالكراسي
Wheelchair|Fauteuil roulant|كرسي متحرك
Stroller|Poussette|عربة أطفال
Dog sled|Traîneau à chiens|زلاجة كلاب
Mail truck|Camion postal|شاحنة بريد
Armored car|Voiture blindée|سيارة مصفحة
Moped|Mobylette|دراجة نارية صغيرة
Bobcat loader|Chargeuse|جرافة صغيرة`,
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
