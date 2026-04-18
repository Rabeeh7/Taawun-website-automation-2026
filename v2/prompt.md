    # Donation Data Formatter Prompt

    Use this prompt with any AI (like ChatGPT or Claude) to quickly convert messy donation data into the exact format required by the bot.

    ---

    ## The Prompt

    Copy and paste the text below into your AI:

    ```text
    Please convert the following donation details into the strict labeled format below. 

    ### Output Format:
    Donor Name: [Full Name]
    Place: [Location]
    Whatsapp Number: [Phone number in E.164 format if available]
    Amount: [Numeric value + Currency Code]
    Chapter: [Chapter name from the list below, or leave blank if unknown]
    C/o: [Care of name, if applicable]
    C/o Phone: [Care of phone number, if applicable]

    ### Rules:
    1. Use only the labels provided above.
    2. For "Amount", ensure one of the following 7 supported currency codes is used: INR, AED, SAR, KWD, BHD, OMR, QAR.
    3. If a field is missing, leave it blank after the colon.
    4. If multiple donations are provided, separate them with an empty line.
    5. TIP: The "C/o" label is flexible! You can use "C/o hudawi: name".
    6. If a "C/o Phone" (care of phone number) is provided, include it on a separate line.
    7. For "Chapter", use EXACTLY one of the chapter names from the list below (case-insensitive, but exact spelling required). If unsure, leave blank.

    ### Supported Chapters:
    KASARGOD, KANNUR, WAYANAD, VATAKARA, KODUVALLY,
    CALICUT, KONDOTTY, MANJERI, WANDOOR, PERINTHALMANNA,
    MALAPPURAM, VENGARA, KOTTAKKAL, TIRUR, TIRURANGADI,
    EDAPPAL, PALAKKAD, TRISSUR, ERANAKULAM, SOUTH KERALA,
    ABU DHABI, AJMAN & UAQ, AL AIN, ANDHRA PRADESH, BANGALORE, BHIWANDI,
    DAWADMI, DUBAI, FUJAIRAH, GUWAHATI, HYDERABAD, JEDDAH, JIZAN,
    KUWAIT, MANGLORE, MUMBAI, NATIONAL HADIA, OMAN, QATAR, RAS AL KHAIMA,
    RIYADH, SAUDI EASTERN (DAMMAM), SEEMANCHAL, SHARJAH, SOUTHEAST ASIA,
    TURKEY, UK, WEST BENGAL, YANBU, GAZWA UNION

    ### Input Data:
    [PASTE YOUR MESSY DATA HERE]
    ```

    ---

    ## Supported Currencies Reference

    | Currency | Code/Keyword | Bot Label |
    | :--- | :--- | :--- |
    | Indian Rupee | INR, rs, ₹ | ₹ INR |
    | UAE Dirham | AED, dirham | د.إ AED |
    | Saudi Riyal | SAR, riyal | ﷼ SAR |
    | Kuwaiti Dinar | KWD, kd | د.ك KWD |
    | Bahraini Dinar | BHD, bd | .د.ب BHD |
    | Omani Rial | OMR, rial | ر.ع. OMR |
    | Qatari Riyal | QAR, qr | ر.ق QAR |

    ---

    ## Example Result

    **Input:**
    `rabeeh from vengara gave 10 aed, he is with nafeel. phone is 1010101010. this is for vengara chapter`

    **Output:**
    ```text
    Donor Name: rabeeh
    Place: vengara
    Whatsapp Number: 1010101010
    Amount: 10 AED
    Chapter: VENGARA
    C/o: nafeel
    C/o Phone: 
    ```

    **Input (multiple donors, mixed chapters):**
    ```
    ali from dubai gave 500 aed for dubai chapter
    john from calicut gave 1000 rs for calicut chapter
    ```

    **Output:**
    ```text
    Donor Name: ali
    Place: dubai
    Whatsapp Number: 
    Amount: 500 AED
    Chapter: DUBAI
    C/o: 
    C/o Phone: 

    Donor Name: john
    Place: calicut
    Whatsapp Number: 
    Amount: 1000 INR
    Chapter: CALICUT
    C/o: 
    C/o Phone: 
    ```
